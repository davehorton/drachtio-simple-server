const {parseAor} = require('./utils');

let registrar, logger;

if (process.env.NODE_ENV === 'test') {
  registrar = require('./plugins/registrar-test');
}
else {
  registrar = require('./plugins/registrar');
}

module.exports = function(opts) {
  logger = opts.logger;

  return (req, res) => {
    const aor = parseAor(req.uri);
    registrar(aor, req)
      .then((contact) => {
        return req.proxy({destination: contact});
      })
      .catch((err) => {
        logger.error(err, `Error finding contact for ${aor}`);
        res.send(404);
      });
  };
};
