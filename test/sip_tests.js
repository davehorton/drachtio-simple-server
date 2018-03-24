const test = require('blue-tape');
const { output, sippUac } = require('./scripts/sipp')('test_simple');
//const debug = require('debug')('drachtio:simple-server');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(srf) {
  return new Promise((resolve, reject) => {
    srf.on('connect', () => {
      return resolve();
    });
  });
}
test('PUBLISH', (t) => {
  const {srf, client} = require('..');

  t.timeoutAfter(20000);

  connect(srf)
    .then(() => {
      return sippUac('uac-publish-unknown-event.xml');
    })
    .then(() => {
      return t.pass('returns 489 Bad Event to unknown event');
    })

    .then(() => {
      srf.disconnect();
      client.quit();
      return t.end();
    })
    .catch((err) => {
      srf.disconnect();
      client.quit();
      console.log(`error received: ${err}`);
      console.log(output());
      t.error(err);
    });
});
