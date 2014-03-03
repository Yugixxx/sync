/*
The MIT License (MIT)
Copyright (c) 2013 Calvin Montgomery

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const VERSION = "3.0.0-RC2";
var singleton = null;
var Config = require("./config");

module.exports = {
    init: function () {
        Logger.syslog.log("Starting CyTube v" + VERSION);
        var chanlogpath = path.join(__dirname, "../chanlogs");
        fs.exists(chanlogpath, function (exists) {
            exists || fs.mkdir(chanlogpath);
        });

        var chandumppath = path.join(__dirname, "../chandump");
        fs.exists(chandumppath, function (exists) {
            exists || fs.mkdir(chandumppath);
        });
        singleton = new Server();
        return singleton;
    },

    getServer: function () {
        return singleton;
    }
};

var path = require("path");
var fs = require("fs");
var http = require("http");
var https = require("https");
var express = require("express");
var Logger = require("./logger");
var Channel = require("./channel");
var User = require("./user");
var $util = require("./utilities");
var db = require("./database");

var Server = function () {
    var self = this;
    self.channels = [],
    self.express = null;
    self.http = null;
    self.https = null;
    self.io = null;
    self.ioWeb = null;
    self.ioSecure = null;
    self.db = null;
    self.api = null;
    self.announcement = null;
    self.httplog = null;
    self.infogetter = null;
    self.torblocker = null;

    // database init ------------------------------------------------------
    var Database = require("./database");
    self.db = Database;
    self.db.init();

    // webserver init -----------------------------------------------------
    self.httplog = new Logger.Logger(path.join(__dirname,
                                               "../httpaccess.log"));
    self.express = express();
    require("./web/webserver").init(self.express);

    // http/https/sio server init -----------------------------------------
    if (Config.get("https.enabled")) {
        var key = fs.readFileSync(path.resolve(__dirname, "..",
                                               Config.get("https.keyfile")));
        var cert = fs.readFileSync(path.resolve(__dirname, "..",
                                                Config.get("https.certfile")));
        var opts = {
            key: key,
            cert: cert,
            passphrase: Config.get("https.passphrase")
        };

        self.https = https.createServer(opts, self.express)
                          .listen(Config.get("https.port"));
    }


    self.http = self.express.listen(Config.get("http.port"),
                                    Config.get("http.host") || undefined);

    if (Config.get("ipv6.enabled")) {
        self.ipv6 = self.express.listen(Config.get("ipv6.port"), Config.get("ipv6.host"));
    }

    require("./io/ioserver").init(self);

    // background tasks init ----------------------------------------------
    require("./bgtask")(self);

    // tor blocker init ---------------------------------------------------
    if (Config.get("enable-tor-blocker")) {
        self.torblocker = require("./torblocker")();
    }
};

Server.prototype.getHTTPIP = function (req) {
    var ip = req.ip;
    if (ip === "127.0.0.1" || ip === "::1") {
        var fwd = req.header("x-forwarded-for");
        if (fwd && typeof fwd === "string") {
            return fwd;
        }
    }
    return ip;
};

Server.prototype.getSocketIP = function (socket) {
    var raw = socket.handshake.address.address;
    if (raw === "127.0.0.1" || raw === "::1") {
        var fwd = socket.handshake.headers["x-forwarded-for"];
        if (fwd && typeof fwd === "string") {
            return fwd;
        }
    }
    return raw;
};

Server.prototype.isChannelLoaded = function (name) {
    name = name.toLowerCase();
    for (var i = 0; i < this.channels.length; i++) {
        if (this.channels[i].uniqueName == name)
            return true;
    }
    return false;
};

Server.prototype.getChannel = function (name) {
    var self = this;
    var cname = name.toLowerCase();
    for (var i = 0; i < self.channels.length; i++) {
        if (self.channels[i].uniqueName === cname)
            return self.channels[i];
    }

    var c = new Channel(name);
    c.on("empty", function () {
        self.unloadChannel(c);
    });
    self.channels.push(c);
    return c;
};

Server.prototype.unloadChannel = function (chan) {
    if (chan.dead) {
        return;
    }

    if (chan.registered) {
        chan.saveState();
    }

    chan.playlist.die();
    chan.logger.close();
    for (var i = 0; i < this.channels.length; i++) {
        if (this.channels[i].uniqueName === chan.uniqueName) {
            this.channels.splice(i, 1);
            i--;
        }
    }

    Logger.syslog.log("Unloaded channel " + chan.name);
    // Empty all outward references from the channel
    var keys = Object.keys(chan);
    for (var i in keys) {
        delete chan[keys[i]];
    }
    chan.dead = true;
};

Server.prototype.packChannelList = function (publicOnly) {
    var channels = this.channels.filter(function (c) {
        if (!publicOnly) {
            return true;
        }

        return c.opts.show_public;
    });

    return channels.map(this.packChannel.bind(this));
};

Server.prototype.packChannel = function (c) {
    var data = {
        name: c.name,
        pagetitle: c.opts.pagetitle,
        mediatitle: c.playlist.current ? c.playlist.current.media.title : "-",
        usercount: c.users.length,
        voteskip_eligible: c.calcVoteskipMax(),
        users: [],
        chat: Array.prototype.slice.call(c.chatbuffer),
        registered: c.registered,
        public: c.opts.show_public
    };

    for (var i = 0; i < c.users.length; i++) {
        if (c.users[i].name !== "") {
            var name = c.users[i].name;
            var rank = c.users[i].rank;
            if (rank >= 255) {
                name = "!" + name;
            } else if (rank >= 4) {
                name = "~" + name;
            } else if (rank >= 3) {
                name = "&" + name;
            } else if (rank >= 2) {
                name = "@" + name;
            }
            data.users.push(name);
        }
    }

    return data;
};

Server.prototype.announce = function (data) {
    if (data == null) {
        this.announcement = null;
        db.clearAnnouncement();
    } else {
        this.announcement = data;
        db.setAnnouncement(data);
        this.io.sockets.emit("announcement", data);
        if (this.ioSecure) {
            this.ioSecure.sockets.emit("announcement", data);
        }
    }
};

Server.prototype.shutdown = function () {
    Logger.syslog.log("Unloading channels");
    for (var i = 0; i < this.channels.length; i++) {
        if (this.channels[i].registered) {
            Logger.syslog.log("Saving /r/" + this.channels[i].name);
            this.channels[i].saveState();
        }
    }
    Logger.syslog.log("Goodbye");
    process.exit(0);
};

