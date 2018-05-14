const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const log = require('../../util/log');

class Scratch3Ev3Blocks {

    /**
     * The ID of the extension.
     * @return {string}
     */
    static get EXTENSION_ID () {
        return 'ev3';
    }

    /**
     * Array of accepted motor ports.
     * @note These should not be translated as they correspond to labels on
     *       the EV3 hub.
     * @type {array}
     */
    static get MOTOR_PORTS () {
        return [
            {
                name: 'A',
                value: 1
            },
            {
                name: 'B',
                value: 2
            },
            {
                name: 'C',
                value: 4
            },
            {
                name: 'D',
                value: 8
            }
        ];
    }

    /**
     * Array of accepted sensor ports.
     * @note These should not be translated as they correspond to labels on
     *       the EV3 hub.
     * @type {array}
     */
    static get SENSOR_PORTS () {
        return ['1', '2', '3', '4'];
    }

    /**
     * High-level primitives / constants used by the extension.
     * @type {object}
     */
    static get PRIMITIVE () {
        return {
            LAYER: 0x00,
            NUM8: 0x81,
            NUM16: 0x82,
            NUM32: 0x83,
            COAST: 0x0,
            BRAKE: 0x1,
            LONGRAMP: 50,
            STEPSPEED: 0xAE,
            TIMESPEED: 0xAF,
            OUTPUTSTOP: 0xA3,
            OUTPUTRESET: 0xA2,
            STEPSPEEDSYNC: 0xB0,
            TIMESPEEDSYNC: 0xB1,
        };
    }

    /**
     * Creates a new instance of the EV3 extension.
     * @param  {object} runtime VM runtime
     * @constructor
     */
    constructor (runtime) {
        // Bind runtime and device manager
        this.runtime = runtime;
        this.deviceManager = this.runtime.ioDevices.deviceManager;

        // EV3 state
        this.connected = false;
        this.speed = 50;

        // Start BT connection with Scratch Link
        // @todo Handle error conditions if Scratch Link is not available
        this.bt = new this.deviceManager.BT();

        // Handle events from Scratch Link
        // @todo This is a method override that is not ideal. This should
        //       probably be handled with event emitters within the wrapper.
        this.bt.didReceiveCall = (method, params) => {
            console.log('override!');
            switch (method) {
                case 'didDiscoverPeripheral':
                    // @todo Present user with options for which device to
                    //       connect to.
                    log(`Peripheral discovered: ${JSON.stringify(params)}`);

                    // Automatically connect to the first discovered device
                    // @todo Reconsider this behavior
                    if (!this.connected) this._connect(params.peripheralId);
                    break;
                case 'didReceiveMessage':
                    log(`Message received from peripheral: ${JSON.stringify(params)}`);
                    break;
                default:
                    return 'Unknown method';
            }
        }

        // @todo The deviceManager should provide a callback when the WS
        //       connection is established. For now, wait some arbitrary amount
        //       of time.
        setTimeout(() => {this._scan()}, 500);
    }

    /**
     * Define the EV3 extension.
     * @return {object} Extension description.
     */
    getInfo () {
        return {
            id: Scratch3Ev3Blocks.EXTENSION_ID,
            name: 'LEGO MINDSTORMS EV3',
            iconURI: null,
            blocks: [
                {
                    opcode: 'motorTurnClockwise',
                    text: '[PORT] turn clockwise [TIME] seconds',
                    blockType: BlockType.COMMAND,
                    arguments: {
                        PORT: {
                            type: ArgumentType.STRING,
                            menu: 'motorPorts',
                            defaultValue: Scratch3Ev3Blocks.MOTOR_PORTS[0].value
                        },
                        TIME: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 1
                        }
                    }
                },
                {
                    opcode: 'motorTurnCounterClockwise',
                    text: '[PORT] turn counter [TIME] seconds',
                    blockType: BlockType.COMMAND,
                    arguments: {
                        PORT: {
                            type: ArgumentType.STRING,
                            menu: 'motorPorts',
                            defaultValue: Scratch3Ev3Blocks.MOTOR_PORTS[0].value
                        },
                        TIME: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 1
                        }
                    }
                },
                {
                    opcode: 'beep',
                    text: 'beep',
                    blockType: BlockType.COMMAND
                }
            ],
            menus: {
                motorPorts: this._buildMenu(Scratch3Ev3Blocks.MOTOR_PORTS),
            }
        };
    }

    /**
     * Create data for a menu in scratch-blocks format, consisting of an array of objects with text and
     * value properties. The text is a translated string, and the value is one-indexed.
     * @param  {object[]} info - An array of info objects each having a name property.
     * @return {array} - An array of objects with text and value properties.
     * @private
     */
    _buildMenu (info) {
        return info.map((entry, index) => {
            const obj = {};
            obj.text = entry.name;
            obj.value = String(index + 1);
            return obj;
        });
    }

    /**
     * Start scanning for elligible EV3 devices.
     * @return {void}
     */
    _scan () {
        this.bt.requestDevice({
            majorDeviceClass: 8,
            minorDeviceClass: 1
        }).then(
            x => {
                log(`requestDevice resolved to: ${JSON.stringify(x)}`);
            },
            e => {
                log(`requestDevice rejected with: ${JSON.stringify(e)}`);
            }
        );
    }

    /**
     * Connect to an EV3 device with the specified peripheral ID.
     * @param  {string} peripheralId Peripheral (Bluetooth Classic) ID
     * @return {void}
     */
    _connect (peripheralId) {
        this.connected = true;
        this.bt.connectDevice({
            peripheralId: peripheralId
        }).then(
            x => {
                log(`connectDevice resolved to: ${JSON.stringify(x)}`);
            },
            e => {
                this.connected = false;
                log(`connectDevice rejected with: ${JSON.stringify(e)}`);
            }
        );
    }

    /**
     * Generate a motor command in EV3 byte array format (CMD, LAYER, PORT,
     * SPEED, RAMP UP, RUN, RAMP DOWN, BREAKING TYPE)
     * @param  {string} command Motor command primitive (i.e. "prefix")
     * @param  {string} port    Port to address
     * @param  {number} n       Value to be passed to motor command
     * @param  {number} speed   Speed value
     * @param  {number} ramp    Ramp value
     * @return {array}          Byte array
     */
    _motorCommand (command, port, n, speed, ramp) {
        /**
         * Generate run values for a given input.
         * @param  {number} run Run input
         * @return {array}      Run values (byte array)
         */
        function getRunValues (run) {
            // If run duration is less than max 16-bit integer
            if (run < 0x7fff) {
                return [
                    Scratch3Ev3Blocks.PRIMITIVE.NUM16,
                    run & 0xff,
                    (run>>8) & 0xff
                ];
            }

            // Run forever
    	    return [
                Scratch3Ev3Blocks.PRIMITIVE.NUM32,
                run & 0xff,
                (run >> 8) & 0xff,
                (run >> 16) & 0xff,
                (run >> 24) & 0xff
            ];
    	}

        // If speed is less than zero, make it positive and multiply the input
        // value by -1
        if (speed < 0) {
    		speed = -1 * speed;
    		n = -1 * n;
    	}

        // If the input value is less than 0
    	let dir = (n < 0) ? 0x100 - speed : speed; // step negative or possitive
    	n = Math.abs(n);

        // @todo ^^^^^ Is all of this shit really needed? ^^^^^

        // Setup motor run duration and ramping behavior
    	let rampup =  ramp;
    	let rampdown = ramp;
    	let run = n - ramp * 2;
    	if (run < 0) {
    		rampup = Math.floor(n / 2);
    		run = 0;
    		rampdown = n - rampup;
    	}

        // Generate motor command
    	let runcmd = getRunValues(run);
    	return [
            command,
            Scratch3Ev3Blocks.PRIMITIVE.LAYER,
            port,
            Scratch3Ev3Blocks.PRIMITIVE.NUM8,
            dir&0xff,
            Scratch3Ev3Blocks.PRIMITIVE.NUM8,
            rampup
        ].concat(runcmd.concat([
            Scratch3Ev3Blocks.PRIMITIVE.NUM8,
            rampdown,
            Scratch3Ev3Blocks.PRIMITIVE.BRAKE
        ]));
    }

    _applyPrefix (n, cmd) {
        const len = cmd.length + 5;
    	return [].concat(
            len & 0xFF,
            (len >> 8) & 0xFF,
            0x1,
            0x0,
            0x0,
            n,
            0x0,
            cmd
        );
    }

    _arrayBufferToBase64 (buffer) {
        var binary = '';
        var bytes = new Uint8Array( buffer );
        var len = bytes.byteLength;
        for (var i = 0; i < len; i++) {
            binary += String.fromCharCode( bytes[ i ] );
        }
        return window.btoa( binary );
    }

    motorTurnClockwise (args) {
        if (!this.connected) return;

        // Validate arguments
        const port = Cast.toNumber(args.PORT);
        const time = Cast.toNumber(args.TIME) * 1000;

        // Build up motor command
        const cmd = this._applyPrefix(0, this._motorCommand(
            Scratch3Ev3Blocks.PRIMITIVE.TIMESPEED,
            port,
            time,
            this.speed,
            Scratch3Ev3Blocks.PRIMITIVE.LONGRAMP
        ));

        // Send message
        this.bt.sendMessage({
            message: this._arrayBufferToBase64(cmd),
            encoding: 'base64'
        });

        // Yield for time
        return new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, time);
        });
    }

    motorTurnCounterClockwise (args) {
        if (!this.connected) return;

        // Validate arguments
        const port = Cast.toNumber(args.PORT);
        const time = Cast.toNumber(args.TIME) * 1000;

        // Build up motor command
        const cmd = this._applyPrefix(0, this._motorCommand(
            Scratch3Ev3Blocks.PRIMITIVE.TIMESPEED,
            port,
            time,
            this.speed * -1,
            Scratch3Ev3Blocks.PRIMITIVE.LONGRAMP
        ));

        // Send message
        this.bt.sendMessage({
            message: this._arrayBufferToBase64(cmd),
            encoding: 'base64'
        });

        // Yield for time
        return new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, time);
        });
    }

    beep () {
        if (!this.connected) return;
        return this.bt.sendMessage({
            message: 'DwAAAIAAAJQBgQKC6AOC6AM=',
            encoding: 'base64'
        });
    }
}

module.exports = Scratch3Ev3Blocks;
