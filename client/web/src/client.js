
var /*const*/ READYSTATE_UNSENT = 0;
var /*const*/ READYSTATE_OPENED = 1;
var /*const*/ READYSTATE_HEADERSRECEIVED = 2;
var /*const*/ READYSTATE_LOADING = 3;
var /*const*/ READYSTATE_DONE = 4;
readyStates = {};
readyStates[READYSTATE_UNSENT] = "UNSENT";
readyStates[READYSTATE_OPENED] = "OPENED";
readyStates[READYSTATE_HEADERSRECEIVED] = "HEADERS_RECEIVED";
readyStates[READYSTATE_LOADING] = "LOADING";
readyStates[READYSTATE_DONE] = "DONE";

String.prototype.trim = function () {
    return this.replace(/^\s*/, "").replace(/\s*$/, "");
}

/// Top-level user-facing abstraction of all Kanaloa client functionality.
/// Parameters:
/// server -- The url of the Kanaloa service to connect to.
/// Properties:
/// OnReceive -- Invoked when a message is received from the server. function(data)
/// OnConnectionLost -- Invoked when an application-level timeout occurs. The server process that is handling this client has died. function()
function KanaloaConnection(server) {
    this.Settings = new _KanaloaHttpSettings();
    this.Server = server;
    this.ConnectionId = null;
    
    this._receiver = null;
    this._sendBatcher = null;
    
    this.OnReceive = function(data) { };
    this.OnConnectionLost = function() { };
    this.OnDebugEvent = function(message) { };
    
    this.Connect();
}

KanaloaConnection.prototype._ReportReceive = function(data) {
    if (this.OnReceive) {
	this.OnReceive(data);
    }
}

KanaloaConnection.prototype._ReportConnectionLost = function() {
    if (this.OnConnectionLost) {
	this.OnConnectionLost();
    }
}

KanaloaConnection.prototype._LogDebug = function(message) {
    if (this.OnDebugEvent) {
	this.OnDebugEvent("Connection: " + message);
    }
}

KanaloaConnection.prototype._BumpIncoming = function(statusCode) {
    if (statusCode == 410) {
	// GONE
	this.ConnectionId = null;
	this._ReportConnectionLost();
    }
}

KanaloaConnection.prototype._BumpOutgoing = function(statusCode) {
    // Same thing.
    this._BumpIncoming(statusCode);
}

KanaloaConnection.prototype.Connect = function() {
    var connection = this;
    connection._LogDebug("Using stream mode? " + connection.Settings.IsStreamMode);
    
    function ConnectionOpened(receiverPost) {
	connection._LogDebug("Opened");
	
	// Now that we have the ConnectionId, we can begin transmitting outgoing posts.
	connection.ConnectionId = receiverPost.ConnectionId;
	connection.Send();
    }

    function ConnectionClosed(receiverPost, statusCode) {
	connection._LogDebug("Closed with status: " + statusCode);
	
	connection._BumpIncoming(statusCode);
	connection.Settings.BumpIncoming(statusCode);
	connection._LogDebug("Waiting " + connection.Settings.IncomingWait + " ms before reconnect.");
	setTimeout(function() { connection.Connect(); }, connection.Settings.IncomingWait);
    }
    
    var receiver = new _KanaloaHttpPost(this.Server + "/" + this.Settings.ConnectionSuffix,
				       this.ConnectionId,
				       this.Settings.ContentType,
				       this.Settings.IsStreamMode,
				       function() { ConnectionOpened(this); },
				       function(data) { connection._ReportReceive(data); },
				       function(httpStatusCode) { ConnectionClosed(this, httpStatusCode); },
				       function(message) { connection._LogDebug(message); }
				       );
    this._receiver = receiver;
    
    receiver.Send("");
}

KanaloaConnection.prototype.Send = function(data) {
    if (this._sendBatcher == null) {
	var connection = this;
	this._sendBatcher = new _KanaloaHttpSendBatcher(this,
						       function(message) { connection._LogDebug(message); }
						       );
    }

    this._sendBatcher.Send(data);
}

var /*const*/ KANALOA_WAIT_INCOMING_BASE = 10;
var /*const*/ KANALOA_WAIT_OUTGOING_BASE = 10;

/// Manages timeouts and other settings for the client.
function _KanaloaHttpSettings() {
    this.IsStreamMode = this._IsStreamMode();
    this.ContentType = "application/json";

    if (this.IsStreamMode) {
	this.ConnectionSuffix = "?t=stream";
    }
    else {
	this.ConnectionSuffix = "?t=longpoll";
    }
    
    this.Reset();
}

_KanaloaHttpSettings.prototype._IsStreamMode = function() {
    var userAgent = navigator.userAgent;
    return (userAgent.indexOf("MSIE") == -1);
}

_KanaloaHttpSettings.prototype.Reset = function() {
    this.IncomingWait = KANALOA_WAIT_INCOMING_BASE;
    this.OutgoingWait = KANALOA_WAIT_OUTGOING_BASE;
}

_KanaloaHttpSettings.prototype.BumpIncoming = function(statusCode) {
    if (statusCode != 200) {
	if (this.IncomingWait == KANALOA_WAIT_INCOMING_BASE) {
	    this.IncomingWait = 1000;
	}
	else if (this.IncomingWait < 100000) {
	    this.IncomingWait *= 2;
	}
    }
}

_KanaloaHttpSettings.prototype.BumpOutgoing = function(statusCode) {
    if (statusCode != 200) {
	if (this.OutgoingWait == KANALOA_WAIT_OUTGOING_BASE) {
	    this.OutgoingWait = 1000;
	}
	else if (this.OutgoingWait < 100000) {
	    this.OutgoingWait *= 2;
	}
    }
}

/// Once a ConnectionId is established by the initial request, this class batches outgoing data.
function _KanaloaHttpSendBatcher(connection, onDebugEvent) {
    this._connection = connection;
    this._outgoing = [];
    this._post = null;

    this._onDebugEvent = onDebugEvent;
}

_KanaloaHttpSendBatcher.prototype._LogDebug = function(message) {
    if (this._onDebugEvent) {
	this._onDebugEvent("HttpSendBatcher: " + message);
    }
}

_KanaloaHttpSendBatcher.prototype.Send = function(data) {
    if (data) {
	this._LogDebug("Adding data \"" + data + "\" to outbox.");
	this._outgoing.push(data);
    }
    
    this._SendPost();
}

_KanaloaHttpSendBatcher.prototype._SendPost = function() {
    if (this._outgoing.length == 0) {
	this._LogDebug("No messages to send.");
	return;
    }
    
    if (this._connection.ConnectionId == null) {
	this._LogDebug("ConnectionId not set yet.");
	return;
    }
    
    if (this._post && this._post.IsActive()) {
	// If the post is still working, wait for it to complete.
	this._LogDebug("A post is still active; waiting for it to complete.");
	return;
    }

    var batcher = this;
    var connection = batcher._connection;
    
    function PostCompleted(post, statusCode) {
	// If successful, remove sent messages from outbox.
	if (statusCode == 200) {
	    for (var i = 0; i < post.sentCount; i++) {
		batcher._outgoing.shift();
	    }
	}

	// Loop to pick up accumulated messages.
	connection._BumpOutgoing(statusCode);
	connection.Settings.BumpOutgoing(statusCode);
	connection._LogDebug("Waiting " + connection.Settings.OutgoingWait + " ms before reconnect.");
	setTimeout(function() { batcher._SendPost(); }, connection.Settings.OutgoingWait);
    }
    
    this._LogDebug("There is no active post; creating a new one.");
    // TODO: Reuse existing post or remove post reconnect logic.
    var post = new _KanaloaHttpPost(connection.Server,
				   connection.ConnectionId,
				   connection.Settings.ContentType,
				   connection.Settings.IsStreamMode,
				   null,
				   null,
				   function(httpStatusCode) { PostCompleted(this, httpStatusCode); },
				   function(message) { batcher._LogDebug(message); }
				   );
    batcher._post = post;
    
    // TODO: Limit size of sent string to 1 MB to match server limit.
    var textOutgoing = JSON.stringify(this._outgoing);
    this._LogDebug("Sending batch \"" + textOutgoing + "\"");
    this._post.Send(textOutgoing);
    this._post.sentCount = this._outgoing.length;
}

/// Wraps XmlHttpRequest to provide lowest-level send and receive functionality.
/// server -- The full URL to post to.
/// connectionId -- The value to set for the ConnectionId header.
/// httpContentType -- The value to set for the Content-Type header.
/// isStreamMode -- If false, will not try to read headers or responseText before request complete (IE compat == false).
/// onReceiveChunk -- On stream-capable browsers, this is fired once per chunk. Otherwise, once per request.
/// onClose -- Fired when the underlying request dies.
/// onDebugEvent -- Reports interesting diagnostic information.
function _KanaloaHttpPost(server, connectionId, httpContentType, isStreamMode, onOpen, onReceiveChunk, onClose, onDebugEvent) {
    this._server = server;
    this.ConnectionId = connectionId;
    this._contentType = httpContentType;
    this._isStreamMode = isStreamMode;
    this._request = null;

    this._onOpen = onOpen;
    this._onReceiveChunk = onReceiveChunk;
    this._onClose = onClose;
    this._onDebugEvent = onDebugEvent;
}

_KanaloaHttpPost.prototype._ReportOpen = function() {
    if (this._onOpen) {
	this._onOpen();
    }
}

_KanaloaHttpPost.prototype._ReportChunk = function(data) {
    if (this._onReceiveChunk) {
	this._onReceiveChunk(data);
    }
}

_KanaloaHttpPost.prototype._ReportClose = function(httpStatusCode) {
    if (this._onClose) {
	this._onClose(httpStatusCode);
    }
}

_KanaloaHttpPost.prototype._LogDebug = function(message) {
    if (this._onDebugEvent) {
	this._onDebugEvent("HttpPost: " + message);
    }
}

_KanaloaHttpPost.prototype.IsActive = function() {
    if (this._request && (this._request.readyState != READYSTATE_UNSENT || this._request.readyState != READYSTATE_DONE)) {
	return false;
    }

    return true;
}

_KanaloaHttpPost.prototype.Connect = function() {
    if (this._request) {
	if (this._request.readyState == READYSTATE_UNSENT) {
	    this._LogDebug("Connect: Using existing request.");
	    return false;
	}

	this._LogDebug("Connect: Aborting existing request.");
	this._request.abort();
	this._request = null;
    }
    
    this._LogDebug("Connect: Creating new request.");

    var connection = this;

    var request = new XMLHttpRequest();
    this._request = request;
    request.lenReceived = 0;
    request.open("POST", this._server);
    
    request.onreadystatechange = function() {
	var readyState = request.readyState;
	connection._LogDebug("State changed to " + readyStates[request.readyState]);
	
	//connection._LogDebug("responseText is \"" + request.responseText + "\"");
	
	if ((connection._isStreamMode && readyState == READYSTATE_HEADERSRECEIVED) ||
	    (!connection._isStreamMode && readyState == READYSTATE_DONE)) {
	    var headers = request.getAllResponseHeaders();
	    connection._LogDebug("AllResponseHeaders is \"" + headers + "\"");
	    
	    var newConnectionId = request.getResponseHeader("ConnectionId");
	    if (newConnectionId) {
		connection._LogDebug("Set new ConnectionId \"" + newConnectionId + "\"");
		connection.ConnectionId = newConnectionId;
	    }
	    
	    connection._LogDebug("status is \"" + request.status + "\"");

	    connection._ReportOpen();
	}
	
	if ((connection._isStreamMode && readyState == READYSTATE_LOADING) ||
	    readyState == READYSTATE_DONE) {
	    var allData = request.responseText;
	    var data = allData.substring(request.lenReceived);
	    data = data.trim();
	    request.lenReceived = allData.length;
	    if (data.length > 0) {
		connection._LogDebug("Received additional responseText \"" + data + "\"");

		var responses = [];
		try {
		    // The response should always be a JSON array.
		    responses = JSON.parse(data);
		}
		catch (ex) {
		    connection._LogDebug("Error parsing responseText \"" + data + "\"");
		}
		
		for (var i = 0; i < responses.length; i++) {
		    var response = responses[i];
		    connection._ReportChunk(response);
		}
	    }
	}
	
	if (readyState == READYSTATE_DONE) {
	    connection._ReportClose(request.status);
	}
    }
    
    if (this.ConnectionId) {
	connection._LogDebug("Setting ConnectionId header to \"" + this.ConnectionId + "\"");
	request.setRequestHeader("ConnectionId", this.ConnectionId);
    }
    if (this._contentType) {
	connection._LogDebug("Setting Content-Type header to \"" + this._contentType + "\"");
	request.setRequestHeader("Content-Type", this._contentType);
    }
    
    return true;
}

_KanaloaHttpPost.prototype.Send = function(data) {
    this.Connect();
    this._request.send(data);
}
