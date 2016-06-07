'use strict';

/*
 * ioTracks: ioTracks node.js SDK
 *
 * ioFabricClient lib that mimics all requests to ioFabric's Local API
 */

const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;
const OPCODE_ACK = 0xB;
const OPCODE_CONTROL_SIGNAL = 0xC;
const OPCODE_MSG = 0xD;
const OPCODE_RECEIPT = 0xE;

var request = require('request');
var WebSocket = require('ws');
var exec = require('child_process').exec;
var ioMessageUtil = require('./lib/ioMessageUtil.js');
var byteUtils = require('./lib/byteUtils.js');

var ELEMENT_ID = "NOT_DEFINED"; // publisher's ID
var SSL = false;
var host = "iofabric";
var port = 54321;

var wsMessage;
var wsControl;

/**
 * Sets custom host and port for connection (if no argument is specified will use the default values).
 *
 * @param host - host' string name
 * @param port - port's number
 * @param containerId - container's ID
 * @param mainCb - main function to perform when all set up and checks are done
 */
exports.init = function(shost, sport, containerId, mainCb) {
    var options = processArgs(process.argv);

    if(options['--id']){ ELEMENT_ID = options['--id']; };

    if(process.env.SELFNAME){ ELEMENT_ID = process.env.SELFNAME; };

    if(process.env.SSL){ SSL = true; };

    if(!(!shost || !shost.trim())){ host = shost; }
    if(!(!sport || sport<=0)){ port = sport; }
    if(!(!containerId || !containerId.trim())) { ELEMENT_ID = containerId; }

    exec("ping -c 3 " + host, function checkHost(error, stdout, stderr) {
        if(stderr != '' || error!==null){
            console.log("Host:" + host + " is not reachable. Changing to '127.0.0.1'");
            host = '127.0.0.1';
        }
        mainCb();
    });
};

/**
 * Utility function to create ioMessage object
 *
 * @param tag - string
 * @param groupid - string
 * @param sequencenumber - integer
 * @param sequencetotal - integer
 * @param priority - byte
 * @param authid - string
 * @param authgroup - string
 * @param chainposition - long
 * @param hash - string
 * @param previoushash - string
 * @param nonce - string
 * @param difficultytarget - integer
 * @param infotype - string
 * @param infoformat - string
 * @param contextdata - {Buffer} array
 * @param contentdata - {Buffer} array
 * @returns {Object} - ioMessage object
 */
exports.ioMessage = function(tag, groupid, sequencenumber, sequencetotal, priority, authid, authgroup, chainposition,
                             hash, previoushash, nonce, difficultytarget, infotype, infoformat, contextdata, contentdata) {
    return ioMessageUtil.ioMessage(tag, groupid, sequencenumber, sequencetotal, priority, ELEMENT_ID, authid, authgroup, chainposition,
        hash, previoushash, nonce, difficultytarget, infotype, infoformat, contextdata, contentdata);
};


/**
 * Posts new ioMessage to ioFabric via Local API REST call
 *
 * @param ioMsg {Object} - ioMessage object to send
 * @param cb - object with callback functions (onError, onBadRequest, onMessageReceipt)
 */
exports.sendNewMessage = function(ioMsg, cb) {
    makeHttpRequest(cb, "/v2/messages/new", ioMessageUtil.toJSON(ioMsg),
        function postNewMsg(body){
            if (body.id && body.timestamp) { cb.onMessageReceipt(body.id, body.timestamp); }
        }
    );
};

/**
 * Gets all unread messages for container via Local API REST call
 *
 * @param cb - object with callback functions (onError, onBadRequest, onMessages)
 */
exports.getNextMessages = function(cb) {
    makeHttpRequest(cb, "/v2/messages/next", {id:ELEMENT_ID},
        function getNextMsgs(body){
            if (body.messages) {
                cb.onMessages(ioMessageUtil.decodeMessages(body.messages));
            }
        }
    );
};

/**
 * Gets all messages from specified publishers within time-frame (only publishers that the container is allowed to access)
 *
 * @param startdate - start date (timestamp) of a time-frame
 * @param enddate - end date (timestamp) of a time-frame
 * @param publishers - array of publishers to get messages
 * @param cb - object with callback functions (onError, onBadRequest, onMessagesQuery)
 */
exports.getMessagesByQuery = function(startdate, enddate, publishers, cb) {
    if(Array.isArray(publishers)) {
        makeHttpRequest(cb, "/v2/messages/query",
            {
                id: ELEMENT_ID,
                timeframestart: startdate,
                timeframeend: enddate,
                publishers: publishers
            } ,
            function getQueryMsgs(body){
                if (body.messages) { cb.onMessagesQuery( body.timeframestart, body.timeframeend,ioMessageUtil.decodeMessages(body.messages)); }
            }
        );
    } else {
        throw new Error('Publishers input is not array!');
    }
}

/**
 * Gets new configurations for the container
 *
 * @param cb - object with callback functions (onError, onBadRequest, onNewConfig)
 */
exports.getConfig = function(cb) {
    makeHttpRequest(cb, "/v2/config/get", {id:ELEMENT_ID},
        function getNewConfig(body){
            if (body.config) { cb.onNewConfig(JSON.parse(body.config)); }
        }
    );
}

/**
 * Opens WebSocket Control connection to ioFabric
 *
 * @param cb - object with callback functions (onError, onNewConfigSignal)
 */
exports.wsControlConnection = function(cb) {
    makeWSRequest(wsControl, cb, "/v2/control/socket/id/",
        function wsHandleControlData(data, flags){
            if(flags.binary && data.length > 0) {
                var opcode = data[0];
                if (opcode == OPCODE_CONTROL_SIGNAL) {
                    cb.onNewConfigSignal();
                    sendAck(wsControl);
                }
            }
        }
    );
}


/**
 * Opens WebSocket Message connection to ioFabric
 *
 * @param sendMsgCb - function that will be triggered when connection is opened (call wsSendMessage in this function)
 * @param cb - object with callback functions (onError, onMessages, onMessageReceipt)
 */
exports.wsMessageConnection = function( sendMsgCb, cb) {
    makeWSRequest(wsMessage, cb, "/v2/message/socket/id/",
        function wsHandleMessageData(data, flags){
            if(flags.binary && data.length > 0) {
                var opcode = data[0];
                if (opcode == OPCODE_MSG) {
                    var pos = 1;
                    var msgLength = data.readUIntBE(pos, 4);
                    pos += 4;
                    var bytes = data.slice(pos, msgLength + pos);
                    var msg = ioMessageUtil.ioMessageFromBuffer(bytes);
                    bytes = null;
                    cb.onMessages([msg]);
                    sendAck();
                } else if(opcode == OPCODE_RECEIPT) {
                    var size = data[1];
                    var pos = 3;
                    var messageId = "";
                    if (size > 0) {
                        messageId = data.slice(pos, pos + size).toString('utf-8');
                        pos += size;
                    }
                    size = data[2];
                    var timestamp = 0;
                    if (size > 0) {
                        timestamp = data.readUIntBE(pos, size);
                    }
                    cb.onMessageReceipt(messageId, timestamp);
                    sendAck(wsMessage);
                }
            }
        },
        sendMsgCb
    );
}

/**
 * Sends ioMessage to ioFabric via WebSocket Message connection if it's opened.
 *
 * @param ioMsg - ioMessage object to send
 */
exports.wsSendMessage = function(ioMsg) {
    if(!wsMessage || wsMessage.readyState != WebSocket.OPEN) { throw new Error('WS is not connected'); }
    var msgBuffer = ioMessageUtil.ioMsgBuffer(ioMsg);
    var opCodeBuffer = new Buffer([OPCODE_MSG]);
    var lengthBuffer = new Buffer(byteUtils.intToBytes(msgBuffer.length));
    var resultBuffer = Buffer.concat([opCodeBuffer, lengthBuffer, msgBuffer ], opCodeBuffer.length + lengthBuffer.length + msgBuffer.length);
    wsMessage.send(resultBuffer, { binary: true, mask: true });
}

/**
 * Utility function sends ACKNOWLEDGE response to ioFabric
 **/
function sendAck(ws){
    var buffer = new Buffer(1);
    buffer[0] = OPCODE_ACK;
    if(ws){ ws.send(buffer, { binary: true, mask: true }); }
}

/**
 * Utility function to build HTTP/HTTPS url based on settings.
 *
 * @param url - relative path for URL
 * @returns string - full HTTP/HTTPS endpoint URL
 */
function getHttpURL(url){
    var protocol = "";
    if(SSL) { protocol = "https"; } else { protocol = "http"; }
    return getEndpointURL(protocol, url);
}

/**
 * Utility function to build WS/WSS url based on settings.
 *
 * @param url - relative path for URL
 * @returns string - full WS/WSS endpoint URL
 */
function getWSURL(url){
    var protocol = "";
    if(SSL) { protocol = "wss"; } else { protocol = "ws"; }
    return getEndpointURL(protocol, url);
}

/**
 * Utility function to build url based protocol, relative url and settings.
 *
 * @param protocol - HTTP or WS
 * @param url - relative path for URL
 * @returns string - endpoint URL
 */
function getEndpointURL(protocol, url){
    return protocol + "://" + host + ":" + port + url;
}

/**
 * Utility function that makes HTTP/HTTPS post request to endpoint URL.
 * Sends specified JSON.
 *
 * @param listenerCb - {Object} that contains listener callbacks (onError, onBadRequest)
 * @param url - endpoint URL
 * @param json - JSON {Object} to send
 * @param processCb - callback to process reponse body
 */
function makeHttpRequest(listenerCb, url, json, processCb) {
    var url = getHttpURL(url);
    request.post({
        url: url,
        headers: {
            'Content-Type': 'application/json'
        },
        json: json
    }, function handleHttpResponse(err, resp, body) {
        if (err) {
            return listenerCb.onError(err);
        }
        if (resp && resp.statusCode == 400) {
            return listenerCb.onBadRequest(body);
        }
        processCb(body);
    });
}

/**
 * Utility function that opens WS/WSS connection to specified URL.
 *
 * @param listenerCb - {Object} that contains listener callback (onError)
 * @param url - endpoint URL
 * @param onDataCb - callback function that will be triggered when message is received from ioFabric
 * @param sendMsgCb - function that will be triggered when connection is opened (call wsSendMessage in this function)
 */
function makeWSRequest(ws, listenerCb, url, onDataCb, sendMsgCb){
    var url = getWSURL(url + ELEMENT_ID);
    ws = new WebSocket(url, {protocolVersion: 13});
    ws.on('message', function handleWsData(data, flags) {
        onDataCb(data, flags);
    });
    ws.on('error', function handleWsError(error) {
        listenerCb.onError(error);
    });
    ws.on('open', function wsOnOpen() {
        if(sendMsgCb){ sendMsgCb(module.exports); }
        ws.on('ping', function wsPing(data, flags){
            if(flags.binary && data.length == 1) {
                var buffer = new Buffer(1);
                buffer[0] = OPCODE_PONG;
                ws.pong(buffer, { binary: true, mask: true });
            }
        });
    });
}

/**
 * Utility function to process start options
 *
 * @param options - array of start options
 */
function processArgs(arr) {
    arr.shift();
    arr.shift();
    var options = {};
    arr.forEach(function handleForEach(arg) {
        if(arg.indexOf('=') > 0) {
            var pieces = arg.split('=');
            options[pieces[0]] = pieces[1];
        }
    });
    return options;
}
