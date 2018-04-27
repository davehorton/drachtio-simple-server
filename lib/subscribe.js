const config = require('config');
const supportedEvents = config.has('supported-events') ? config.get('supported-events') : [];
const {parseEventHeader, getDefaultSubscriptionExpiry} = require('./utils');
const debug = require('debug')('drachtio:simple-server');
/**
 * @module subscribe
 * @see https://tools.ietf.org/html/rfc3265
 *
 * This module exposes an State Agent per RFC 3265.
 */

let logger, db;

module.exports = function(opts) {
  logger = opts.logger;
  db = opts.db;

  return (req, res) => {
    if (validate(req, res)) {
      debug(`expiry: ${req.expiry}`);
      if (0 === req.expiry) remove(req, res);
      else {
        const to = req.getParsedHeader('To');
        const from = req.getParsedHeader('From');
        debug(`subscribe from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, data: ${JSON.stringify(req.event)}`);
        if (!to.params.tag) {
          initial(req, res);
        }
        else {
          if (req.event.id) {
            db.findSubscriptionById(from.uri, req.uri, req.event.name, req.event.id)
              .then((subscription) => {
                return refresh(req, res, subscription);
              })
              .catch((err) => {
                if (err.code !== 'E_MISSING_SUBSCRIPTION') {
                  logger.error(`Error retrieving subscription: ${err}`);
                }
                initial(req, res);
              });
          }
          else {
            db.findSubscriptionByDialog(from.uri, req.uri, req.event.name, req.get('Call-ID'))
              .then((subscription) => {
                return refresh(req, res, subscription);
              })
              .catch((err) => {
                if (err.code !== 'E_MISSING_SUBSCRIPTION') {
                  logger.error(`Error retrieving subscription: ${err}`);
                }
                initial(req, res);
              });
          }
        }
      }
    }
  };
};

function initial(req, res) {
  debug(`new SUBSCRIBE for ${req.uri} with Call-ID ${req.get('Call-ID')}`);

  db.addSubscription(req.event, req.expiry)
    .then(() => {
      return res.send(202);
    })
    .then(() => {
      return notify(req.srf, req.event);

    })
    .catch((err) => {
      logger.error(`subscribe#initial: Error adding subscription: ${err}`);
      res.send(480);
    });
}

function refresh(req, res, subscription) {
  debug(`refreshing SUBSCRIBE for ${req.uri} with Call-ID ${req.get('Call-ID')}`);
  res.send(503);
}

function remove(req, res) {
  debug(`unsubscribe SUBSCRIBE for ${req.uri} with Call-ID ${req.get('Call-ID')}`);
  db.removeSubscription(req.event)
    .then(() => {
      return res.send(202);
    })
    .catch((err) => {
      logger.error(`subscribe#initial: Error adding subscription: ${err}`);
      res.send(202);
    });
}

function notify(srf, subscription) {
  debug(`subscribe#notify: ${JSON.stringify(subscription)}`);
  db.getEventState(subscription.resource, subscription.name)
    .then((state) => {
      debug(`subscribe#notify: retrieved event state: ${JSON.stringify(state)}`);
      let body;
      const headers = {
        'Call-ID': subscription.callId
      };

      if (state) {
        Object.assign(headers, {'Content-Type': state.contentType});
        body = state.content;
      }

      return srf.request(subscription.subscriber, {
        method: 'NOTIFY',
        headers,
        body
      });
    })
    .catch((err) => {
      logger.error(`subscribe#notify: error retrieving state ${subscription.resource}:${subscription.name} - ${err}`);
    });
}

function validate(req, res) {
  if (!req.has('Event')) {
    logger.error(`SUBSCRIBE request is missing Event header: ${req.get('Call-ID')}`);
    res.send(400);
    return false;
  }
  const to = req.getParsedHeader('to');
  const from = req.getParsedHeader('from');
  const {event, id} = parseEventHeader(req.get('Event'));
  req.event = {
    subscriber: from.uri,
    resource: to.uri,
    name: event,
    id: id,
    accept: req.get('Accept'),
    callId: req.get('Call-ID')
  };

  // remove any undefined values
  Object.keys(req.event).forEach((prop) => { if (!req.event[prop]) delete req.event[prop]; });

  if (-1 === supportedEvents.indexOf(event)) {
    logger.error(`SUBSCRIBE request for unsupported event ${req.get('Event')}: ${req.get('Call-ID')}`);
    res.send(489);
    return false;
  }

  req.expiry = req.has('Expires') ? parseInt(req.get('Expires')) : getDefaultSubscriptionExpiry(event);

  if (config.has('methods.subscribe.expires.max') && req.expiry > config.get('methods.subscribe.expires.max')) {
    req.expiry = config.get('methods.subscribe.expires.max');
    debug(`subscribe#validate: reducing Expires value to ${req.expiry}`);
  }
  if (req.expiry !== 0 && config.has('methods.subscribe.expires.min') &&
    req.expiry < config.get('methods.subscribe.expires.min')) {
    res.send(423, 'Interval Too Brief', {
      headers: {
        'Min-Expires': config.has('methods.subscribe.expires.max') ? config.get('methods.subscribe.expires.max') : 3600
      }
    });
    return false;
  }
  return true;
}
