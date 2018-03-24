const xmlParser = require('xml2js').parseString;
const XmlElement = require('xml2js-extra');
const debug = require('debug')('drachtio:simple-server');

module.exports = function(content) {
  return new Promise((resolve, reject) => {
    xmlParser(content, (err, result) => {
      if (err) return reject(err);
      debug(`parsed xml content: ${JSON.stringify(result)}`);
      resolve(new XmlElement('presence', result.presence));
    });
  });
};
