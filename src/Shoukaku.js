const { RawRouter, ReconnectRouter } = require('./router/ShoukakuRouter.js');
const constants = require('./constants/ShoukakuConstants.js');
const ShoukakuSocket = require('./node/ShoukakuSocket.js');
const EventEmitter = require('events');

/**
 * @external Client
 * @see {@link https://discord.js.org/#/docs/main/master/class/Client}
 */
/**
 * @external Guild
 * @see {@link https://discord.js.org/#/docs/main/master/class/Guild}
 */
/**
 * @external EventEmitter
 * @see {@link https://nodejs.org/api/events.html}
 */
/**
 * @external Map
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map}
 */
class Shoukaku extends EventEmitter {
    /**
     * Shoukaku, governs the client's node connections.
     * @extends {external:EventEmitter}
     * @param  {external:Client} client Your Discord.js client
     * @param {ShoukakuConstants#ShoukakuOptions} [options=ShoukakuOptions] Options to initialize Shoukaku with
     */
    constructor(client, options) {
        super();
        /**
        * The instance of Discord.js client used with Shoukaku.
        * @type {external:Client}
        */
        this.client = client;
        /**
        * The user id of the bot that is being governed by Shoukaku.
        * @type {?string}
        */
        this.id = null;
        /**
        * The shard count of the bot that is being governed by Shoukaku.
        * @type {?number}
        */
        this.shardCount = null;
        /**
        * The current nodes that is being handled by Shoukaku.
        * @type {external:Map}
        */
        this.nodes = new Map();

        Object.defineProperty(this, 'options', { value: this._mergeDefault(constants.ShoukakuOptions, options) });
        Object.defineProperty(this, 'init', { value: true, writable: true });
        Object.defineProperty(this, 'rawRouter', { value: RawRouter.bind(this) });
        Object.defineProperty(this, 'reconnectRouter', { value: ReconnectRouter.bind(this) });
    }
    /**
     * Gets all the Players governed by the Nodes / Sockets in this instance.
     * @type {external:Map}
     */
    get players() {
        const players = new Map();
        for (const node of this.nodes.values()) {
            for (const [id, player] of node.players) players.set(id, player);
        }
        return players;
    }
    /**
     * Gets the number of total Players that is currently active on all nodes in this instance.
     * @type {number}
     */
    get totalPlayers() {
        let counter = 0;
        for (const node of this.nodes.values()) counter += node.players.size;
        return counter;
    }

    // Events
    /**
     * Emitted when a Lavalink Node sends a debug event.
     * @event Shoukaku#debug
     * @param {string} name The name of the Lavalink Node that sent a debug event.
     * @param {Object} data The actual debug data
     */
    /**
     * Emitted when a lavalink Node encouters an error. This event MUST BE HANDLED.
     * @event Shoukaku#error
     * @param {string} name The name of the Lavalink Node that sent an error event or 'Shoukaku' if the error is from Shoukaku.
     * @param {Error} error The error encountered.
     * @example
     * // <Shoukaku> is your own instance of Shoukaku
     * <Shoukaku>.on('error', console.error);
     */
    /** name, code, reason, isReconnectable
     * Emitted when a Lavalink Node becomes Ready from a Reconnection or First Connection.
     * @event Shoukaku#ready
     * @param {string} name The name of the Lavalink Node that sent a ready event.
     * @param {boolean} reconnect True if the session reconnected, otherwise false.
     */
    /**
     * Emitted when a Lavalink Node closed.
     * @event Shoukaku#closed
     * @param {string} name The name of the Lavalink Node that sent a close event.
     * @param {number} code The WebSocket close code https://github.com/Luka967/websocket-close-codes
     * @param {reason} reason The reason for this close event.
     */
    /**
     * Emitted when a Lavalink Node will not try to reconnect again.
     * @event Shoukaku#disconnected
     * @param {string} name The name of the Lavalink Node that sent a close event.
     * @param {string} reason The reason for the disconnect.
     */
    // Events End

    /**
     * The starting point of Shoukaku, must be called in ready event in order for Shoukaku to work.
     * @param {ShoukakuConstants#ShoukakuNodeOptions} nodes An array of lavalink nodes for Shoukaku to connect to.
     * @param {ShoukakuConstants#ShoukakuBuildOptions} options Options that is need by Shoukaku to build herself.
     * @returns {void}
     */
    build(nodes, options) {
        if (!this.init) throw new Error('You cannot build Shoukaku twice');
        options = this._mergeDefault(constants.ShoukakuBuildOptions, options);
        this.id = options.id;
        this.shardCount = options.shardCount;
        for (let node of nodes) {
            node = this._mergeDefault(constants.ShoukakuNodeOptions, node);
            this.addNode(node);
        }
        this.client.on('raw', this.rawRouter);
        this.client.on('shardReady', this.reconnectRouter);
        this.init = false;
    }
    /**
    * Function to register a Lavalink Node
    * @param {ShoukakuConstants#ShoukakuNodeOptions} nodeOptions An array of lavalink nodes for Shoukaku to connect to.
    * @returns {void}
    */
    addNode(nodeOptions) {
        const node = new ShoukakuSocket(this, nodeOptions);
        node.connect(this.id, this.shardCount, false);
        const _close = this._reconnect.bind(this);
        const _ready = this._ready.bind(this);
        node.on('debug', (name, data) => this.emit('debug', name, data));
        node.on('error', (name, error) => this.emit('error', name, error));
        node.on('ready', _ready);
        node.on('close', _close);
        this.nodes.set(node.name, node);
    }
    // noinspection JSCommentMatchesSignature
    /**
     * Function to remove a Lavalink Node
     * @param {string} name The Lavalink Node to remove
     * @returns {boolean} true if the node was removed with no problems. Otherwise false.
     */
    removeNode(name, libraryInvoked = false) {
        const node = this.nodes.get(name);
        if (!node) return false;
        node.removeAllListeners();
        node._executeCleaner();
        this.nodes.delete(name);
        if (!libraryInvoked) this.emit('disconnected', name, 'User invoked disconnection');
        return true;
    }
    /**
     * Shortcut to get the Ideal Node or a manually specified Node from the current nodes that Shoukaku governs.
     * @param {boolean|string} [name] If blank, Shoukaku will automatically return the Ideal Node for you to connect to. If name is specifed, she will try to return the node you specified.
     * @returns {ShoukakuSocket}
     * @example
     * const node = <Shoukaku>.getNode();
     * node.rest.resolve('Kongou Burning Love', 'youtube')
     *     .then(data => {
     *         node.joinVoiceChannel({
     *             guildID: 'guild_id',
     *             voiceChannelID: 'voice_channel_id'
     *         }).then(player => player.playTrack(data.track))
     *     })
     */
    getNode(name) {
        if (!this.nodes.size)
            throw new Error('No nodes available. What happened?');
        if (name) {
            const node = this.nodes.get(name);
            if (node) return node;
            throw new Error('The node name you specified is not one of my nodes');
        }
        return [...this.nodes.values()].sort((a, b) => a.penalties - b.penalties).shift();
    }
    /**
    * Shortcut to get the Player of a guild, if there is any.
    * @param {string} guildID The guildID of the guild we are trying to get.
    * @returns {?ShoukakuPlayer}
    */
    getPlayer(guildID) {
        if (!guildID) return null;
        if (!this.nodes.size) return null;
        return this.players.get(guildID);
    }

    send(payload) {
        const guild = this.client.guilds.get(payload.d.guild_id);
        if (!guild) return;
        guild.shard.send(payload);
    }

    _ready(name, resumed) {
        const node = this.nodes.get(name);
        if (!resumed) node._executeCleaner();
        this.emit('ready', name, resumed);
    }

    _reconnect(name, code, reason) {
        const node = this.nodes.get(name);
        if (node.reconnectAttempts < this.options.reconnectTries) {
            node.reconnectAttempts++;
            try {
                node.connect(this.id, this.shardCount, this.options.resumable);
            } catch (error) {
                this.emit('error', 'Shoukaku', error);
                setTimeout(() => this._reconnect(name, code, reason), 2500);
                return;
            }
        } else {
            this.removeNode(name, true);
            this.emit('disconnected', name, `Failed to reconnect in ${this.options.reconnectTries} attempts`);
            return;
        }
        this.emit('close', name, code, reason);
    }

    // noinspection JSMethodCanBeStatic
    _mergeDefault(def, given) {
        if (!given) return def;
        const defaultKeys = Object.keys(def);
        for (const key of defaultKeys) {
            if (def[key] === null) {
                if (!given[key]) throw new Error(`${key} was not found from the given options.`);
            }
            if (!given[key]) given[key] = def[key];
        }
        for (const key in defaultKeys) {
            if (defaultKeys.includes(key)) continue;
            delete given[key];
        }
        return given;
    }
}
module.exports = Shoukaku;
