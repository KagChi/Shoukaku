const { promisify } = require('util');
const { ShoukakuStatus } = require('../constants/ShoukakuConstants.js');
const { CONNECTED, CONNECTING, DISCONNECTING, DISCONNECTED } = ShoukakuStatus;
const ShoukakuError = require('../constants/ShoukakuError.js');
const { wait } = require('../util/ShoukakuUtil.js');

/**
 * ShoukakuLink, contains data about the voice connection on the guild.
 * @class ShoukakuLink
 */
class ShoukakuLink {
    /**
     * @param {ShoukakuPlayer} player The player of this link.
     * @param {ShoukakuSocket} node The node that governs this link.
     * @param {Guild} guild A Discord.js Guild Object.
     */
    constructor(player, node, guild) {
        /**
         * The player class of this link.
         * @type {ShoukakuPlayer}
         */
        this.player = player;
        /**
         * The node that governs this Link
         * @type {ShoukakuSocket}
         */
        this.node = node;
        /**
         * The ID of the guild that is being governed by this Link.
         * @type {string}
         */
        this.guildID = guild.id;
        /**
         * The sessionID of this Link
         * @type {?string}
         */
        this.sessionID = null;
        /**
         * The ID of the voice channel that is being governed by this link.
         * @type {?string}
         */
        this.voiceChannelID = null;
        /**
         * Voice region where this link is connected.
         * @type {?string}
         */
        this.region = null;
        /**
         * If the client user is self muted.
         * @type {boolean}
         */
        this.selfMute = false;
        /**
         * If the client user is self defeaned.
         * @type {boolean}
         */
        this.selfDeaf = false;
        /**
         * The current state of this link.
         * @type {ShoukakuConstants#ShoukakuStatus}
         */
        this.state = DISCONNECTED;
        /**
         * If this link detected a voice channel change.
         * @type {boolean}
         */
        this.channelMoved = false;
        /**
         * If this link detected a voice server change.
         * @type {boolean}
         */
        this.voiceMoved = false;

        Object.defineProperty(this, 'lastServerUpdate', { value: null, writable: true });
        Object.defineProperty(this, 'callback', { value: null, writable: true });
        Object.defineProperty(this, 'timeout', { value: null, writable: true });
    }

    get guild() {
        return this.node.shoukaku.client.guilds.cache.get(this.guildID);
    }

    get voiceChannelExists() {
        return this.guild && (!this.guild.deleted && (this.guild.channels.cache.has(this.voiceChannelID) && !this.guild.channels.cache.get(this.voiceChannelID).deleted));
    }

    /**
     * Attempts to reconnect this ShoukakuLink, A use case for this is when your Discord Websocket re-identifies
     * @memberOf ShoukakuLink
     * @returns {Promise<ShoukakuPlayer>}
     */
    async attemptReconnect() {
        if (!this.voiceChannelExists)
            throw new ShoukakuError('Voice channel doesn\'t exist to reconnect on');
        try {
            this.node.players.delete(this.guildID);
            await this.node.send({ op: 'destroy', guildId: this.guildID });
            await wait(750);
            this.node.players.set(this.guildID, this.player);
        } catch (error) {
            if (!this.node.players.has(this.guildID)) this.node.players.set(this.guildID, this.player);
            throw error;
        }
        this.lastServerUpdate = null;
        await wait(750);
        await promisify(this.connect.bind(this))({ guildID: this.guildID, voiceChannelID: this.voiceChannelID, mute: this.selfMute, deaf: this.selfDeaf });
        return this.player;
    }

    async moveToNode(node) {
        try {
            if (!node) throw new ShoukakuError('No available nodes to reconnect to');
            this.node.emit('debug', this.node.name, `[Voice] Moving from Node ${this.node.name} => Node ${node.name} | Guild ${this.guildID}, Channel ${this.voiceChannelID}`);
            this.node.players.delete(this.guildID);
            await this.node.send({ op: 'destroy', guildId: this.guildID });
            this.node = node;
            await this.voiceUpdate();
            await this.player.resume();
            this.node.players.set(this.guildID, this.player);
            this.node.emit('debug', this.node.name, `[Voice] Success! Now at Node ${node.name} | Guild ${this.guildID}, Channel ${this.voiceChannelID}`);
        } catch (error) {
            this.player.emit('error', error);
        }
    }

    send(d) {
        if (!this.guild) return;
        this.guild.shard.send({ op: 4, d });
    }

    stateUpdate(data) {
        this.selfDeaf = data.self_deaf;
        this.selfMute = data.self_mute;
        if (this.voiceChannelID) this.channelMoved = data.channel_id && this.voiceChannelID !== data.channel_id;
        if (data.session_id) this.sessionID = data.session_id;
        if (data.channel_id) this.voiceChannelID = data.channel_id;
        if (!data.channel_id) this.state = DISCONNECTED;
        this.node.emit('debug', this.node.name, `[Voice] State Update Received => Guild ${this.guildID}, Channel ${data.channel_id}, State ${this.state}, Channel Moved? ${!!this.channelMoved}`);
    }

    serverUpdate(data) {
        this.lastServerUpdate = data;
        if (data.endpoint) {
            if (this.lastServerUpdate) this.voiceMoved = !data.endpoint.startsWith(this.region);
            this.region = data.endpoint.split('.').shift().replace(/[0-9]/g, '');
        }
        this.node.emit('debug', this.node.name, `[Voice] Forwarding Server Update => Node ${this.node.name}, Voice Server Moved? ${this.voiceMoved}`);
        return this.voiceUpdate()
            .then(() => {
                this.node.emit('debug', this.node.name, `[Voice] Established => Guild ${this.guildID}, Channel ${this.voiceChannelID}`);
                if (this.state === CONNECTING) this.state = CONNECTED;
                if (this.callback) this.callback(null, this.player);
            })
            .catch(error => {
                if (this.state === CONNECTING) {
                    this.send({ guild_id: this.guildID, channel_id: null, self_mute: false, self_deaf: false });
                    this.state = DISCONNECTED;
                    if (this.callback) this.callback(error);
                } else {
                    this.player.emit('error', error);
                }
            })
            .finally(() => {
                clearTimeout(this.timeout);
                this.callback = null;
                this.timeout = null;
            });
    }
    
    connect(options, callback) {
        if (!callback)
            throw new ShoukakuError('No callback supplied.');
        if (!options) {
            callback(new ShoukakuError('No options supplied'));
            return;
        }
        if (this.state === CONNECTING) {
            callback(new ShoukakuError('Can\'t connect while a connection is connecting. Wait for it to resolve first'));
            return;
        }
        this.state = CONNECTING;
        this.callback = callback;
        this.timeout = setTimeout(() => {
            this.send({ guild_id: this.guildID, channel_id: null, self_mute: false, self_deaf: false });
            this.node.emit('debug', this.node.name, `[Voice] Request Connection Timeout => Guild ${this.guildID}, Channel ${voiceChannelID}`);
            this.state = DISCONNECTED;
            clearTimeout(this.timeout);
            this.timeout = null;
            this.callback(new ShoukakuError('The voice connection is not established in 20 seconds'));
            this.callback = null;
        }, 20000);
        const { guildID, voiceChannelID, deaf, mute } = options;
        this.send({ guild_id: guildID, channel_id: voiceChannelID, self_deaf: deaf, self_mute: mute });
        this.node.emit('debug', this.node.name, `[Voice] Request Connection => Guild ${this.guildID}, Channel ${voiceChannelID}`);
    }

    disconnect() {
        if (this.state !== DISCONNECTED) this.state = DISCONNECTING;
        this.node.players.delete(this.guildID);
        this.player.removeAllListeners();
        this.player.reset();
        this.lastServerUpdate = null;
        this.sessionID = null;
        this.voiceChannelID = null;
        this.node.send({ op: 'destroy', guildId: this.guildID })
            .then(() => this.node.emit('debug', this.node.name, `[Voice] Destroyed => Guild ${this.guildID}`))
            .catch(error => this.node.emit('error', this.node.name, error))
            .finally(() => {
                if (this.state === DISCONNECTED) return;
                this.send({ guild_id: this.guildID, channel_id: null, self_mute: false, self_deaf: false });
                this.node.emit('debug', this.node.name, `[Voice] Disconnected => Guild ${this.guildID}`);
                this.state = DISCONNECTED;
            });
    }

    voiceUpdate() {
        return this.node.send({ op: 'voiceUpdate', guildId: this.guildID, sessionId: this.sessionID, event: this.lastServerUpdate });
    }
}
module.exports = ShoukakuLink;
