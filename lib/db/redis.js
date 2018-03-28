const redis = require('redis');
const config = require('config');
const Emitter = require('events');
const {generateETag} = require('../utils');
const async = require('async');
const debug = require('debug')('drachtio:simple-server');
const ZSET = 'event_zset';

/**
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

function makeKey(aor, event) {
  return `${aor}:${event}`;
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

  addEventState(aor, expiry, eventType, contentType, content) {
    const etag = generateETag();
    const key = makeKey(aor, eventType);
    const data = {
      aor,
      eventType,
      etag,
      contentType,
      content
    };

    return new Promise((resolve, reject) => {
      debug(`Db#addEventState: saving event state for key ${key} with expiry ${expiry}: ${JSON.stringify(data)}`);
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
    const key = makeKey(aor, eventType);

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
    const key = makeKey(aor, eventType);

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
    const key = makeKey(data.aor, data.eventType);
    const etag = data.etag = generateETag();

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
        const key = makeKey(data.aor, data.eventType);
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
}

module.exports = Db;
