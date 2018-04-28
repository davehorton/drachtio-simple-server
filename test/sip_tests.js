const test = require('blue-tape');
const { output, sippUac } = require('./scripts/sipp')('test_simple');
//const debug = require('debug')('drachtio:simple-server');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

test('initialize', (t) => {
  const {srf, db} = require('..');
  t.timeoutAfter(10000);

  Promise.all([connect(srf), connect(db)])
    .then(() => {
      return db.flushdb();
    })
    .then((result) => {
      t.ok(result === 'OK', 'cleared database');
      return t.end();
    })
    .catch((err) => {
      t.end(err);
    });
});

test('PUBLISH', (t) => {
  const {srf, db} = require('..');

  t.timeoutAfter(60000);

  Promise.resolve()
    .then(() => {
      return sippUac('uac-publish-unknown-event.xml');
    })
    .then(() => {
      return t.pass('returns 489 Bad Event to unknown event');
    })
    .then(() => {
      return sippUac('uac-publish-missing-event.xml');
    })
    .then(() => {
      return t.pass('returns 400 Bad Request when no Event header');
    })
    .then(() => {
      return sippUac('uac-publish-reduce-expiry.xml');
    })
    .then(() => {
      return t.pass('Expires header is reduced to specified limit if too large');
    })
    .then(() => {
      return sippUac('uac-publish-default-expires.xml');
    })
    .then(() => {
      return t.pass('Expires defaults to local configuration if no Expires header received');
    })
    .then(() => {
      return sippUac('uac-publish-expires-too-short.xml');
    })
    .then(() => {
      return t.pass('returns 423 Interval Too Brief if Expires is too small');
    })
    .then(() => {
      return sippUac('uac-publish-presence-5s.xml');
    })
    .then(() => {
      t.pass('PUBLISH initial state succeeds');
      const {aor} = db.lastInsert;
      return db.getEventState(aor, 'presence');
    })
    .then((obj) => {
      t.ok(obj, 'event state can be retrieved by aor');
      const {etag} = db.lastInsert;
      return db.getEventStateByETag(etag);
    })
    .then((obj) => {
      const {aor} = db.lastInsert;
      t.ok(obj.aor === aor, 'event state can be retrieved by etag');
      return;
    })
    .then(() => {
      return db.getCountOfEtags();
    })
    .then((count) => {
      return t.ok(count === 1, 'there is one active ETag now');
    })
    .then(() => {
      t.pass('wait 5s for event state to expire');
      return new Promise((resolve) => {
        setTimeout(() => { resolve();}, 5500);
      });
    })
    .then(() => {
      const {aor} = db.lastInsert;
      return db.getEventState(aor, 'presence');
    })
    .then((obj) => {
      t.ok(obj === null, 'event state has expired after 5s');
      return db.purgeExpired();
    })
    .then((nExpired) => {
      return t.ok(nExpired === 1, '\'purgeExpired\' removes secondary indices for expired state');
    })
    .then(() => {
      return db.getCountOfEtags();
    })
    .then((count) => {
      return t.ok(count === 0, 'there are no active ETag now');
    })
    .then(() => {
      return sippUac('uac-publish-refresh-etag-unknown.xml');
    })
    .then(() => {
      t.pass('returns 412 Conditional Request Failed to refreshing PUBLISH with unknown ETag (numeric)');
      return;
    })
    .then(() => {
      return sippUac('uac-publish-refresh-etag-unknown2.xml');
    })
    .then(() => {
      t.pass('returns 412 Conditional Request Failed to refreshing PUBLISH with unknown ETag (non-numeric)');
      return;
    })
    .then(() => {
      return sippUac('uac-publish-presence-5s.xml');
    })
    .then(() => {
      const {etag} = db.lastInsert;
      t.pass(`initial state published with ETag: ${etag}`);
      return sippUac('uac-publish-refresh-success.xml', ['-set', 'etag', etag]);
    })
    .then(() => {
      const {etag} = db.lastRefresh;
      t.pass(`state was refreshed with new ETag: ${etag}`);
      return db.getEventStateByETag(etag);
    })
    .then(() => {
      t.pass('state can be retrieved using new ETag');
      const {etag} = db.lastInsert;
      return db.getEventStateByETag(etag);
    }).
    then((data) => {
      if (data === null) return t.pass('state can not be retrieved using old ETag');
      else throw new Error('old ETag still exists after refresh');
    })
    .then(() => {
      t.pass('wait 5s to verify event state has new expiry');
      return new Promise((resolve) => {
        setTimeout(() => { resolve();}, 5500);
      });
    })
    .then(() => {
      const {aor} = db.lastRefresh;
      return db.getEventState(aor, 'presence');
    })
    .then((obj) => {
      const {etag} = db.lastRefresh;
      t.ok(obj !== null, 'after refresh event state has new expiry');
      return sippUac('uac-publish-modify-success.xml', ['-set', 'etag', etag]);
    })
    .then(() => {
      const {etag} = db.lastModify;
      t.pass(`state was modified with new ETag: ${etag}`);
      return db.getCountOfEtags();
    })
    .then((count) => {
      const {etag} = db.lastModify;
      t.ok(count === 1, 'old ETag is removed when event state was modified');
      return sippUac('uac-publish-remove-success.xml', ['-set', 'etag', etag]);
    })
    .then(() => {
      t.pass('PUBLISH with Expires: 0 removes event state');
      return db.getCountOfEtags();
    })
    .then((count) => {
      t.ok(count === 0, 'count of ETags is now zero');
      return db.getCountOfKeys();
    })
    .then((count) => {
      t.ok(count === 0, 'count of keys is now zero');
      return;
    })


    .then(() => {
      //srf.disconnect();
      //db.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      t.error(err);
      console.log(`error: ${err}: ${err.stack}`);
      srf.disconnect();
      db.disconnect();
      //console.log(output());
      t.end();
    });
});

test('SUBSCRIBE', (t) => {
  const {srf, db} = require('..');

  t.timeoutAfter(60000);

  Promise.resolve()
    .then(() => {
      return sippUac('uac-subscribe-non-existent-dialog.xml');
    })
    .then(() => {
      return t.pass('returns 481 to new SUBSCRIBE with Expires: 0');
    })
    .then(() => {
      return sippUac('uac-subscribe-unknown-event.xml');
    })
    .then(() => {
      t.pass('return 489 Bad Event to unknown event');
      return sippUac('uac-subscribe-missing-event.xml');
    })
    .then(() => {
      t.pass('return 400 Bad Request if Event header not provided');
      return sippUac('uac-subscribe-expires-too-short.xml');
    })
    .then(() => {
      t.pass ('return 423 Interval too short if Expires is < min');
      return sippUac('uac-subscribe-notify-unsubscribe.xml');
    })
    .then(() => {
      t.pass('successfully subscribe-notify-unsubscribe for presence events');
      return db.getCountOfSubscriptions();
    })
    .then((count) => {
      return t.ok(count === 0, 'No subscriptions after removal');
    })
    .then(() => {
      return sippUac('uac-publish-presence-5s.xml');
    })
    .then(() => {
      t.pass('successfully published event state for a resource');
      return sippUac('uac-subscribe-notify-with-content.xml');
    })
    .then(() => {
      t.pass('successfully subscribed and got initial event state...waiting 5s for expiry');
      return sippUac('uac-publish-presence-5s.xml');
    })
    .then(() => {
      return sippUac('uac-subscribe-expire.xml');
    })
    .then(() => {
      t.pass('subscription removed after expiration');
      return sippUac('uac-subscribe-refresh.xml');
    })
    .then(() => {
      return t.pass('successfully refreshed subscription');
    })

    .then(() => {
      srf.disconnect();
      db.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      t.error(err);
      console.log(`error: ${err}: ${err.stack}`);
      srf.disconnect();
      db.disconnect();
      console.log(output());
      t.end();
    });
});
