const redis = require('redis');
const config = require('config');
const Emitter = require('events');
const short = require('short-uuid');
const translator = short();
const {generateETag} = require('../utils');
const async = require('async');
const assert = require('assert');
const debug = require('debug')('drachtio:simple-server');
const ZSET = 'event_zset';

/**
 *
 * Data model:
 * I. Event State
 * Event state is maintained in a redis hash that has both a key and a secondary index.
 * The hash consists of:
 *   - aor (address of record)
 *   - event type
 *   - entity tag
 *   - content type
 *   - content
 * The hash is keyed by es:aor:${event type}; e.g es:resource@example.com:presence
 *
 * The secondary index is the entity tag, so we can look up event state either by aor or by entity tag
 *
 * II. Subscriptions
 * Subscriptions are maintained in a redis hash consisting of:
 *   - subscriber aor (address of record of subscriber)
 *   - resource aor (address of record being subscribed to)
 *   - event type
 *   - id (if provided in the Event header of the SUBSCRIBE request)
 *   - SIP Call-ID of SUBSCRIBE dialog
 *   - Accept header (if provided in SUBSCRIBE)
 *  The hash is keyed by sub:${uuid} where uuid is randomly generated
 *
 * we need to retrieve subscriptions in the following ways:
 *   - by subscriber aor, resource aor, event type, and id
 *   - by subscriber aor, resource aor, event type, and call-id
 * to do this we have the following keys:
 *   subkeyid:${res-aor}:${event type}:${sub-aor}:${id}
 *   subkeydlg:${res-aor}:${event type}:${sub-aor}:${call-id}
 */

function makeEventStateKey(aor, event) {
  return `es:${aor}:${event}`;
}

function makeSubStateKey() {
  return `sub:${translator.new()}`;
}

function makeSubStateKeyId(subscriber, resource, event, id) {
  return `subkeyid:${resource}:${event}:${subscriber}:${id}`;
}

function makeSubStateKeyDialog(subscriber, resource, event, callid) {
  return `subkeydlg:${resource}:${event}:${subscriber}:${callid}`;
}

function makeSubStateKeyWildCard(resource, event) {
  return `subkeydlg:${resource}:${event}:*`;
}

class Db extends Emitter {
  /**
   * Creates an instance of the persistence layer backed by redis
   * @param  {[type]} opts [description]
   * @return {[type]}      [description]
   */
  constructor(opts) {
    super();
    this.logger = opts.logger;
    this._init();
  }

  get lastInsert() {
    return this._lastInsert;
  }

  get lastRefresh() {
    return this._lastRefresh;
  }

  get lastModify() {
    return this._lastModify;
  }

  _init() {
    const redisOpts = Object.assign('test' === process.env.NODE_ENV ?
      {
        retry_strategy: () => {},
        disable_resubscribing: true,
      } : {}
    ) ;
    this.client = redis.createClient(config.get('redis.port'), config.get('redis.address'), redisOpts);
    this.client.on('connect', () => {
      this.logger.info(`successfully connected to redis at ${config.get('redis.address')}:${config.get('redis.port')}`);
      this.emit('connect');
    })
      .on('error', (err) => {
        this.logger.error(err, 'redis connection error') ;
      });
  }

  disconnect() {
    this.client.quit();
  }

  /** Event State */


  addEventState(aor, expiry, eventType, contentType, content) {
    const etag = generateETag();
    const key = makeEventStateKey(aor, eventType);
    const data = {
      aor,
      eventType,
      etag,
      contentType,
      content
    };

    return new Promise((resolve, reject) => {
      debug(`Db#addEventState: adding event state for key ${key} with expiry ${expiry}: ${JSON.stringify(data)}`);
      this.client.multi()
        .hmset(key, data)
        .expire(key, expiry)
        .zadd(ZSET, parseInt(etag), key)
        .exec((err, replies) => {
          if (err) return reject(err);

          // for test purposes only
          this._lastInsert = { aor, etag };

          debug(`Db#addEventState: replies ${JSON.stringify(replies)}`);

          resolve(data);
        });
    });
  }

  getEventState(aor, eventType) {
    const key = makeEventStateKey(aor, eventType);

    return new Promise((resolve, reject) => {
      this.client.hgetall(key, (err, obj) => {
        if (err) return resolve(err);
        debug(`Db#getEventState: retrieved event state for key ${key}: ${JSON.stringify(obj)}`);
        resolve(obj);
      });
    });
  }

  getEventStateByETag(etag) {

    return new Promise((resolve, reject) => {
      const cmd = [ZSET, `${etag}`, `${etag}`];
      debug(`Db#getEventStateByETag: ${cmd}`);
      this.client.zrangebyscore(cmd, (err, obj) => {
        if (err) {
          debug(`getEventStateByETag: etag ${etag}, err ${err}`);
          this.logger.info(`getEventStateByETag: etag ${etag}, err ${err}`);
          return resolve(null); // probably an etag that is not a number
        }
        if (Array.isArray(obj) && obj.length === 0) return resolve(null);
        if (Array.isArray(obj) && obj.length === 1) {
          this.client.hgetall(obj[0], (err, data) => {
            if (err) return resolve(err);
            debug(`Db#getEventStateByETag: retrieved event state for etag ${etag}: ${JSON.stringify(data)}`);
            resolve(data);
          });
          return;
        }
        debug(`Db#getEventStateByETag: retrieved unexpected result for etag ${etag}: ${JSON.stringify(obj)}`);
        reject(`Unexpected result for getEventStateByETag for ${etag}`);
      });
    });
  }

  refreshEventState(aor, eventType, expiry) {
    const etag = generateETag();
    const key = makeEventStateKey(aor, eventType);

    return new Promise((resolve, reject) => {
      debug(`Db#refreshEventState: refeshing event state for key ${key} with expiry ${expiry} and new etag: ${etag}`);
      this.client.multi()
        .hset(key, 'etag', etag)
        .expire(key, expiry)
        .zrem(ZSET, key)
        .zadd(ZSET, parseInt(etag), key)
        .exec((err, replies) => {
          if (err) return reject(err);

          // for test purposes only
          this._lastRefresh = { aor, etag };

          debug(`Db#refreshEventState: replies ${JSON.stringify(replies)}`);

          resolve(etag);
        });
    });
  }

  modifyEventState(data, expiry, contentType, content) {
    const key = makeEventStateKey(data.aor, data.eventType);
    const etag = data.etag = generateETag();
    data.content = content;

    return new Promise((resolve, reject) => {
      debug(`Db#modifyEventState: refeshing event state for key ${key} with expiry ${expiry} and new etag: ${etag}`);
      debug(`Db#modifyEventState: new event state: ${JSON.stringify(data)}`);
      this.client.multi()
        .hmset(key, data)
        .expire(key, expiry)
        .zrem(ZSET, key)
        .zadd(ZSET, parseInt(etag), key)
        .exec((err, replies) => {
          if (err) return reject(err);

          // for test purposes only
          this._lastModify = { aor: data.aor, etag };

          debug(`Db#modifyEventState: replies ${JSON.stringify(replies)}`);

          resolve(etag);
        });
    });
  }

  removeEventState(etag) {
    return this.getEventStateByETag(etag)
      .then((data) => {
        if (!data) {
          throw new Error(`db#removeEventState etag not found: ${etag}`);
        }
        const key = makeEventStateKey(data.aor, data.eventType);
        return new Promise((resolve, reject) => {
          this.client.multi()
            .del(key)
            .zrem(ZSET, key)
            .exec((err, replies) => {
              if (err) return reject(err);

              // for test purposes only
              this._lastRemove = {aor: data.aor, etag};
              debug(`Db#removeEventState: replies ${JSON.stringify(replies)}`);

              resolve(data.aor);
            });
        });
      });
  }

  purgeExpired() {
    let nExpired = 0 ;
    return new Promise((resolve, reject) => {
      const cmd = [ZSET, '-inf', '+inf'];
      this.client.zrangebyscore(cmd, (err, arr) => {
        if (err) {
          debug(`purgeExpired: err ${err}`);
          return reject(err);
        }
        debug(`Db#purgeExpired - checking ${arr.length} sorted set items`);

        async.each(arr, (aor, callback) => {
          this.client.hgetall(aor, (err, obj) => {
            if (err) {
              this.logger.error(`Db#purgeExpired error checking existence of key ${obj}: ${err}`);
              callback(err);
            }
            else if (null === obj) {
              debug(`Db#purgeExpired - removing expired item ${aor}`);
              this.client.zrem([ZSET, aor], (err, reply) => {
                if (err) {
                  console.log(`Db#purgeExpired error removing entry ${aor} from sorted set: ${err}`);
                  return callback(err);
                }
                nExpired++;
                debug(`Db#purgeExpired removed entry ${aor}: ${reply}`);
                callback(null);
              });
            }
            else {
              debug(`found ${JSON.stringify(obj)} for key ${aor}`);
              callback(null);
            }
          });
        }, (err) => {
          if (err) return reject(err);
          resolve(nExpired);
        });
      });
    });
  }

  getCountOfEtags() {
    return new Promise((resolve, reject) => {
      this.client.zcount([ZSET, '-inf', '+inf'], (err, count) => {
        if (err) return reject(err);
        resolve(count);
      });
    });
  }

  getCountOfKeys() {
    return new Promise((resolve, reject) => {
      this.client.keys('*', (err, keys) => {
        if (err) return reject(err);

        debug(`db#getCountOfKeys: keys: ${keys}`);
        resolve(keys.length);
      });
    });
  }

  flushdb() {
    assert(process.env.NODE_ENV === 'test');
    return new Promise((resolve, reject) => {
      this.client.flushdb((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  dump(type) {
    return new Promise((resolve, reject) => {
      if (type === 'etag') {
        const cmd = [ZSET, '-inf', '+inf'];
        debug(`Db#getEventStateByETag: ${cmd}`);
        this.client.zrangebyscore(cmd, (err, obj) => {
          if (err) {
            this.logger.error(err, 'db.dump etag');
            return reject(err);
          }
          this.logger.info(obj, 'db.dump etag');
          debug(`etags: ${JSON.stringify(obj)}`);
          resolve(obj);
        });
      }
      else {
        resolve();
      }
    });
  }
  /** Subscriptions */

  findSubscriptions(resource, event) {
    const key = makeSubStateKeyWildCard(resource, event);

    return new Promise((resolve, reject) => {
      this.client.keys(key, (err, dlgKeys) => {
        if (err) return reject(err);
        debug(`Db#findSubscriptionsForEvent: retrieved subscription keys ${dlgKeys} for key: ${key}`);
        if (!dlgKeys) return reject(new Error('E_NO_SUBSCRIPTION'));

        const subscribers = [];
        async.each(dlgKeys,
          (dlgkey, callback) => {
            debug(`Db#findSubscriptionsForEvent calling hgetall for key ${dlgkey}`);
            this.client.get(dlgkey, (err, key) => {
              this.client.hgetall(key, (err, obj) => {
                if (err) return callback(err);
                debug(`Db#findSubscriptionsForEvent event state for key ${key}: ${JSON.stringify(obj)}`);
                subscribers.push(obj);
                callback();
              });
            });
          }, (err) => {
            if (err) reject(err);
            resolve(subscribers);
          });
      });
    });
  }

  /*
  findSubscriptionById(subscriber, resource, event, id) {
    const key = makeSubStateKeyId(subscriber, resource, event, id);

    return new Promise((resolve, reject) => {
      this.client.get(key, (err, value) => {
        if (err) return reject(err);
        debug(`Db#findSubscriptionById: retrieved subscription key ${value} for key: ${key}`);
        if (!value) return reject(new Error('E_MISSING_SUBSCRIPTION'));

        this.client.hgetall(value, (err, obj) => {
          if (err) return reject(err);
          if (!obj) return reject(new Error('E_MISSING_SUBSCRIPTION'));
          resolve(obj);
        });
      });
    });
  }

  findSubscriptionByDialog(subscriber, resource, event, callId) {
    const key = makeSubStateKeyDialog(subscriber, resource, event, callId);

    return new Promise((resolve, reject) => {
      this.client.get(key, (err, value) => {
        if (err) return reject(err);
        debug(`Db#findSubscriptionByDialog: retrieved subscription key ${value} for key: ${key}`);
        if (!value) return reject(new Error('E_MISSING_SUBSCRIPTION'));

        this.client.hgetall(value, (err, obj) => {
          if (err) return reject(err);
          if (!obj) return reject(new Error('E_MISSING_SUBSCRIPTION'));
          resolve(obj);
        });
      });
    });
  }
  */

  addSubscription(obj, expiry) {
    const key = makeSubStateKey();
    const keyDialog = makeSubStateKeyDialog(obj.subscriber, obj.resource, obj.eventType, obj.callId);

    debug(`db#addSubscription ${key} and ${keyDialog} with expiry ${expiry} for ${JSON.stringify(obj)}`);

    return new Promise((resolve, reject) => {
      const multi = this.client.multi()
        .hmset(key, obj)
        .set(keyDialog, key)
        .expire(key, expiry)
        .expire(keyDialog, expiry);
      if (obj.id) {
        const keyId = makeSubStateKeyId(obj.subscriber, obj.resource, obj.eventType, obj.id);
        multi
          .set(keyId, key)
          .expire(keyId, expiry);
      }
      multi.exec((err, replies) => {
        if (err) return reject(err);

        debug(`Db#addSubscription: replies ${JSON.stringify(replies)}`);
        resolve(obj);
      });
    });
  }

  removeSubscription(obj) {
    const keyDialog = makeSubStateKeyDialog(obj.subscriber, obj.resource, obj.eventType, obj.callId);

    return new Promise((resolve, reject) => {
      this.client.get(keyDialog, (err, value) => {
        if (err) return reject(err);

        debug(`db.removeSubscription: retrieved value ${value} for key ${keyDialog}`);
        const multi = this.client.multi()
          .del(keyDialog)
          .del(value);
        if (obj.id) {
          const keyId = makeSubStateKeyId(obj.subscriber, obj.resource, obj.eventType, obj.id);
          multi.del(keyId);
        }
        multi.exec((err, replies) => {
          if (err) return reject(err);

          debug(`Db#removeSubscription: replies ${JSON.stringify(replies)}`);
          resolve();
        });
      });
    });
  }

  getCountOfSubscriptions() {
    return new Promise((resolve, reject) => {
      this.client.keys('sub:*', (err, keys) => {
        if (err) return reject(err);

        debug(`db#getCountOfSubscriptions: keys: ${keys}`);
        resolve(keys.length);
      });
    });
  }

}

module.exports = Db;
