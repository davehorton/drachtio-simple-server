const auth = require('drachtio-mw-digest-auth') ;
const config = require('config');
const _ = require('lodash');

/**
 * @module authenticate
 * @see https://www.npmjs.com/package/drachtio-mw-digest-auth
 *
 * In order to authenticate, we need access to passwords for users
 * This is a test stub, used in the test cases.
 * You will need to create your own version and require it in app.js
 */
module.exports = auth({
  realm: config.get('domain'),
  passwordLookup: (username, realm, callback) => {
    const u = _.find(config.get('test-users'), (o) => {return o.username === username;});
    if (u) return callback(null, u.password);
    callback(new Error(`unknown user ${username}`));
  }
});
