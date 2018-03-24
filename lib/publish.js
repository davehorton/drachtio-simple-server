const config = require('config');

/**
 * @module publish
 * @see https://tools.ietf.org/html/rfc3903
 *
 * This module exposes an Event State Compositor (ESC) per RFC 3903.
 *
 * Data model:
 * Event state is maintained in a redis hash that has both a key and a secondary index.
 * The hash consists of:
 *   - aor (address of record)
 *   - event type
 *   - entity tag
 *   - content type
 *   - content
 * The hash is keyed by aor:${event}; e.g 15541@domain.com:event
 *
 * The secondary index is the entity tag, so we can look up event state either by aor or by entity tag
 */

let logger, redis;

module.exports = function(opts) {
  logger = opts.logger;
  redis = opts.client;

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
        if (!hasExpires) throw new Error('Expires header is required on initial PUBLISH');
        return initial(req, res);
      }
      else if (!hasContent && hasSipIfMatch) {
        if (!hasExpires) throw new Error('Expires header is required on refresh PUBLISH');
        return refresh(req, res);
      }
      else if (hasContent && hasSipIfMatch && expiry > 0) {
        return modify(req, res);
      }
      else if (!hasContent && hasSipIfMatch && expiry === 0) {
        return remove(req, res);
      }
      else {
        res.send(400);
        throw new Error(`invalid PUBLISH: ${JSON.stringify(req)}`);
      }
    }
  };
};

function initial(req, res)  {
}

function refresh(req, res)  {
}

function modify(req, res)  {
}

function remove(req, res)  {
}

function validate(req, res) {
  const supportedEvents = config.get('supported-events');

  if (!req.has('Event')) {
    logger.error(`PUBLISH request is missing Event header: ${req.get('Call-ID')}`);
    return res.send(400);
  }
  if (-1 === supportedEvents.indexOf(req.get('Event'))) {
    logger.error(`PUBLISH request for unsupported event ${req.get('Event')}: ${req.get('Call-ID')}`);
    res.send(489);
    return false;
  }

  return true;
}
