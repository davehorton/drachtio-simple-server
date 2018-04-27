const config = require('config');

module.exports = function(opts) {
  return (req, res) => {
    res.send(200, {
      headers: {
        'Allow': 'INVITE, REGISTER, SUBSCRIBE, PUBLISH, MESSAGE',
        'Allow-Events': config.get('supported-events').join(',')
      }
    });
  };
};
