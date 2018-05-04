const config = require('config');
const { parseAor } = require('./utils');
const SipError = require('drachtio-srf').SipError;
const debug = require('debug')('drachtio:simple-server');
/**
 * @module publish
 * @see https://tools.ietf.org/html/rfc3903
 *
 * This module exposes an Event State Compositor (ESC) per RFC 3903.
 */

let logger, db;

module.exports = function(opts) {
  logger = opts.logger;
  db = opts.db;

  return (req, res) => {
    const hasContent = req.has('Content-Type');
    const hasSipIfMatch = req.has('SIP-If-Match');
    const hasExpires = req.has('Expires');
    let expiry;
    if (hasExpires) {
      expiry = parseInt(req.get('Expires'));
    }

    if (validate(req, res)) {
      if (hasContent && !hasSipIfMatch) {
        return initial(req, res);
      }
      else if (hasContent && hasSipIfMatch && expiry > 0) {
        return modify(req, res);
      }
      else if (!hasContent && hasSipIfMatch && expiry === 0) {
        return remove(req, res);
      }
      else if (!hasContent && hasSipIfMatch) {
        return refresh(req, res);
      }
    }
  };
};

function initial(req, res)  {
  const aor = parseAor(req.uri);
  logger.info(`publish#initial aor: ${aor} event: ${req.get('Event')} content-type: ${req.get('Content-Type')}`);
  return db.addEventState(aor, req.expiry, req.get('Event'), req.get('Content-Type'), req.body)
    .then((data) => {
      return res.send(200, {
        headers: {
          'Expires': req.expiry,
          'SIP-ETag': data.etag
        }
      });
    })
    .then(() => {
      return notifySubscribers(req, aor, req.get('Event'), req.get('Content-Type'), req.body);
    })
    .then((count) => {
      return logger.info(`publish#initial: notified ${count} subscribers`);
    })
    .catch((err) => {
      res.send(480);
    });
}

function refresh(req, res)  {
  const etag = req.get('SIP-If-Match');
  logger.info(`publish#refresh etag: ${etag}`);
  db.getEventStateByETag(etag)
    .then((obj) => {
      if (!obj) {
        debug(`publish#refresh etag: ${etag} no state found`);
        throw new SipError(412);
      }
      debug(`publish#refresh etag: ${etag} retrieved state ${JSON.stringify(obj)}`);
      return db.refreshEventState(obj.aor, obj.eventType, req.expiry);
    })
    .then((etag) => {
      return res.send(200, {
        headers: {
          'Expires': req.expiry,
          'SIP-ETag': etag
        }
      });
    })
    .catch((err) => {
      if (err instanceof SipError) return res.send(err.status);
      logger.error(err, `publish#refresh error retrieving state for ${etag}`);
      res.send(500);
    });
}

function modify(req, res)  {
  const etag = req.get('SIP-If-Match');
  logger.info(`publish#modify etag: ${etag}`);
  db.getEventStateByETag(etag)
    .then((obj) => {
      if (!obj) {
        debug(`publish#refresh etag: ${etag} no state found`);
        throw new SipError(412);
      }
      debug(`publish#refresh etag: ${etag} retrieved state ${JSON.stringify(obj)}`);
      logger.info(obj, `publish#refresh etag: ${etag}`);
      if (obj.eventType !== req.get('Event')) {
        logger.info(`publish#modify Event ${req.get('Event')} does not match stored type: ${obj.eventType}`);
        throw new SipError(412);
      }
      return db.modifyEventState(obj, req.expiry, req.get('Content-Type'), req.body);
    })
    .then((etag) => {
      res.send(200, {
        headers: {
          'Expires': req.expiry,
          'SIP-ETag': etag
        }
      });
      return etag;
    })
    .then(() => {
      return notifySubscribers(req, parseAor(req.uri), req.get('Event'), req.get('Content-Type'), req.body);
    })
    .then((count) => {
      return logger.info(`publish#modify: notified ${count} subscribers`);
    })
    .catch((err) => {
      if (err instanceof SipError) return res.send(err.status);
      logger.error(err, `publish#refresh error retrieving state for ${etag}`);
      res.send(500);
    });
}

function remove(req, res)  {
  const etag = req.get('SIP-If-Match');
  logger.info(`publish#remove etag: ${etag}`);
  db.removeEventState(etag)
    .then((aor) => {
      logger.info(`publish#remove removed event state for ${aor}, ETag ${etag}`);
      return res.send(200);
    })
    .catch((err) => {
      logger.info(`publish#remove failed to remove event state for ETag ${etag}: ${err}`);
      res.send(412);
    });
}

function notifySubscribers(req, resource, event, contentType, content) {
  debug(`publish#notifySubscribers - searching for subs for ${resource}:${event}`);
  return db.findSubscriptions(resource, event)
    .then((subs) => {
      debug(`publish#notifySubscribers - found ${JSON.stringify(subs)}`);
      subs.forEach((obj) => {
        req.srf.request(req.socket, obj.subscriber, {
          method: 'NOTIFY',
          headers: {
            'Call-ID': obj.callId,
            'Content-Type': contentType,
            'Subscription-State': 'active',
            'Event': event
          },
          body: content
        }, (err, req) => {
          if (err) return logger.error(err, `Error sending NOTIFY: ${err}`);
          req.on('response', (res) => {
            logger.info(`publish#notifySubscribers got ${res.status} response to NOTIFY`);
            if (-1 !== [408, 481].indexOf(res.status)) {
              logger.info(`publish#notifySubscribers: got ${res.status} to NOTIFY, removing subscription`);
              db.removeSubscription(obj);
            }
          });
        });
      });
      return subs.length;
    })
    .catch((err) => {
      if (err.message !== 'E_NO_SUBSCRIPTION') {
        logger.error(err, 'publish#notifySubscribers');
      }
      else {
        debug('publish#notifySubscribers - no subscriptions found');
      }
    });
}

function validate(req, res) {
  const supportedEvents = config.get('supported-events');

  if (!req.has('Event')) {
    logger.info(`PUBLISH request is missing Event header: ${req.get('Call-ID')}`);
    res.send(400);
    return false;
  }
  if (-1 === supportedEvents.indexOf(req.get('Event'))) {
    logger.info(`PUBLISH request for unsupported event ${req.get('Event')}: ${req.get('Call-ID')}`);
    res.send(489);
    return false;
  }

  req.expiry = parseInt(req.has('Expires') ?
    req.get('Expires') :
    (config.has('methods.publish.expires.default') ? config.get('methods.publish.expires.default') : 3600));

  if (config.has('methods.publish.expires.max') && req.expiry > config.get('methods.publish.expires.max')) {
    req.expiry = config.get('methods.publish.expires.max');
    debug(`publish#validate: reducing Expires value to ${req.expiry}`);
  }
  if (req.expiry !== 0 && config.has('methods.publish.expires.min') &&
    req.expiry < config.get('methods.publish.expires.min')) {
    res.send(423, 'Interval Too Brief', {
      headers: {
        'Min-Expires': config.has('methods.publish.expires.max') ? config.get('methods.publish.expires.max') : 3600
      }
    });
    return false;
  }

  return true;
}
