const config = require('config');
const supportedEvents = config.has('supported-events') ? config.get('supported-events') : [];
const {parseAor, parseEventHeader, getDefaultSubscriptionExpiry} = require('./utils');
const _ = require('lodash');
const assert = require('assert');
const debug = require('debug')('drachtio:simple-server');
/**
 * @module subscribe
 * @see https://tools.ietf.org/html/rfc3265
 *
 * This module exposes an State Agent per RFC 3265.
 */

let logger, db;
const dialogs = new Map();

module.exports = function(opts) {
  logger = opts.logger;
  db = opts.db;

  return (req, res) => {
    if (validate(req, res)) {
      initial(req, res);
    }
  };
};

function initial(req, res) {
  logger.info(req.event, 'subscribe#initial');
  debug(req.event, 'subscribe#initial');
  let subscription;

  db.addSubscription(req.event, req.expiry)
    .then((sub) => {
      subscription = sub;
      return req.srf.createUAS(req, res, {headers: {'Expires': req.expiry}});
    })
    .then((uas) => {
      uas
        .on('unsubscribe', (req, res) => remove(req, res, uas, subscription))
        .on('subscribe', (req, res) => refresh(req, res, uas, subscription));

      startSubscriptionTimer(uas, subscription, req.expiry);
      return notify(req.event, uas, 'active');
    })
    .catch((err) => {
      logger.error(err, `subscribe#initial: Error: ${err}`);
      res.send(480);
    });
}

function refresh(req, res, dlg, subscription) {
  const event = req.get('Event');
  const expiry = (req.has('Expires') ?
    parseInt(req.get('Expires')) : getDefaultSubscriptionExpiry(event)) || 3600;

  logger.info(req.event, `subscribe#refresh with expiry ${expiry}`);
  debug(`subscribe#refresh with expiry ${expiry}`);
  return db.removeSubscription(subscription)
    .then(() => {
      return db.addSubscription(subscription, expiry);
    })
    .then(() => {
      return clearSubscriptionTimer(dlg, subscription, true);
    })
    .then(() => {
      return startSubscriptionTimer(dlg, subscription, expiry);
    })
    .then(() => {
      return res.send(202);
    })
    .then(() => {
      return notify(subscription, dlg, 'active');
    })
    .catch((err) => {
      logger.error(err, 'subscribe#refresh');
      res.send(480);
    });
}

function remove(req, res, dlg, subscription) {
  logger.info(subscription, 'subscribe#remove');
  notify(subscription, dlg, 'terminated');
  db.removeSubscription(subscription);
  clearSubscriptionTimer(dlg, subscription, true);
}

function notify(sub, dlg, subscriptionState) {
  db.getEventState(sub.resource, sub.eventType)
    .then((state) => {
      debug(`subscribe#notify: got event state for ${sub.resource}:${sub.eventType} ${JSON.stringify(state)}`);
      let body;
      const headers = {
        'Call-ID': sub.callId,
        'Subscription-State': subscriptionState,
        'Event': sub.eventType
      };

      if (state && subscriptionState !== 'terminated') {
        Object.assign(headers, {'Content-Type': state.contentType});
        body = state.content;
      }
      return dlg.request({
        method: 'NOTIFY',
        body,
        headers
      });
    })
    .catch((err) => {
      logger.error(err, sub, `subscribe#notify: error retrieving state: ${err}`);
    });
}

function validate(req, res) {
  if (!req.has('Event')) {
    logger.info(`SUBSCRIBE request is missing Event header: ${req.get('Call-ID')}`);
    res.send(400);
    return false;
  }
  const to = req.getParsedHeader('to');
  const from = req.getParsedHeader('from');
  const {event, id} = parseEventHeader(req.get('Event'));
  req.event = {
    subscriber: parseAor(from.uri),
    resource: parseAor(to.uri),
    eventType: event,
    id: id,
    accept: req.get('Accept'),
    callId: req.get('Call-ID')
  };

  // remove any undefined values
  req.event = _.omitBy(req.event, _.isNil);
  debug(`subscribe#validate: req.event: ${JSON.stringify(req.event)}`);

  if (-1 === supportedEvents.indexOf(event)) {
    logger.info(`SUBSCRIBE request for unsupported event ${req.get('Event')}: ${req.get('Call-ID')}`);
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
  if (0 === req.expiry) {
    res.send(481); // unsubscribe should be within a dialog
    return false;
  }

  return true;
}

function startSubscriptionTimer(dlg, subscription, expiry) {
  const timer = setTimeout(_expireSubscription.bind(null, dlg, subscription), expiry * 1000);

  const subs = dialogs.get(dlg.id) || [];
  subs.push({subscription, timer});
  dialogs.set(dlg.id, subs);
}

function clearSubscriptionTimer(dlg, subscription, andCancel) {
  const subs = dialogs.get(dlg.id);
  const arr = _.remove(subs, (s) => { return s.subscription.eventType === subscription.eventType; });
  assert(Array.isArray(arr) && arr.length === 1);

  if (andCancel) clearTimeout(arr[0].timer);
  if (0 === subs.length) dialogs.delete(dlg.id);

  debug(`subscribe#clearSubscriptionTimer: after clearing subscription there are ${dialogs.size} dialogs`);
}

function _expireSubscription(dlg, subscription) {
  logger.info(subscription, `subscription timed out on dialog with Call-ID ${dlg.sip.callId}`);
  notify(subscription, dlg, 'terminated');

  // NOTE: no need to call db.removeSubscription(subscription) because keys were set to expire on their own
  clearSubscriptionTimer(dlg, subscription);
}
