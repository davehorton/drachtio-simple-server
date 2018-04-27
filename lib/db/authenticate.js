const auth = require('drachtio-mw-digest-auth') ;
const config = require('config');
const _ = require('lodash');

/**
 * @module authenticate
 * @see https://www.npmjs.com/package/drachtio-mw-digest-auth
 */
module.exports = auth({
  realm: config.get('domain'),
  passwordLookup: (username, realm, callback) => {

    // this is a stub for the test cases
    // TODO: implement your own specific logic to return the password
    const u = _.find(config.get('test-users'), (o) => {return o.username === username;});
    if (u) return callback(null, u.password);
    callback(new Error(`unknown user ${username}`));
  }
});
