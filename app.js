const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf();
const Db = require('./lib/db/redis');
const argv = require('minimist')(process.argv.slice(2));
const noop = () => {};
const logger = pino({serializers: {err: pino.stdSerializers.err}});
const db = new Db({logger});

if (process.env.NODE_ENV === 'test') {
  logger.info = noop;
}

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

// if there are arguments without an option, these are the request types to handle
// e.g. node app.js publish subscribe # will only handle PUBLISH and SUBSCRIBE messages

const enabled = {};
['subscribe', 'publish', 'message'].forEach((type) => {
  enabled[type] = argv._.length === 0 || -1 != argv._.indexOf(type);
});

// support either inbound or outbound connections based on config
if (config.has('drachtio.host')) {
  srf.connect(config.get('drachtio'));
  srf.on('connect', (err, hostport) => {
    logger.info(`successfully connected to drachtio listening on ${hostport}`);
  });

  if (process.env.NODE_ENV !== 'test') {
    srf.on('error', (err) => {
      logger.info(`error connecting to drachtio: ${err}`);
    });
  }
}
else {
  logger.info(`listening for connections from drachtio on port ${config.get('drachtio.port')}`);
  srf.listen(config.get('drachtio'));
}

let authenticator;
if (process.env.NODE_ENV === 'test') {
  authenticator = require('./lib/plugins/authenticate-test');
}
else {
  authenticator = require('./lib/plugins/your-authenticator-here');
}

if (enabled.options) {
  const optionsHandler = require('./lib/options.js')({logger, db});
  srf.options(optionsHandler);
}

if (enabled.subscribe) {
  const subscribeHandler = require('./lib/subscribe.js')({logger, db});
  if (config.has('methods.subscribe.authenticate') && config.get('methods.subscribe.authenticate') === true) {
    srf.use('subscribe', authenticator);
  }
  srf.subscribe(subscribeHandler);
}
if (enabled.publish) {
  const publishHandler = require('./lib/publish.js')({logger, db});
  srf.publish(publishHandler);
}
if (enabled.message) {
  const messageHandler = require('./lib/message.js')({logger, db});
  if (config.has('methods.message.authenticate') && config.get('methods.message.authenticate') === true) {
    srf.use('message', authenticator);
  }
  srf.message(messageHandler);
}

module.exports = {srf, db};
