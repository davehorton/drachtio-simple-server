const parseUri = require('drachtio-srf').parseUri;
const config = require('config');
const uuid = require('short-uuid')('123456789');

const obj = module.exports = {};

obj.parseAor = function(u) {
  const uri = parseUri(u);
  let domain = uri.host.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
  if (!domain && config.has('domain')) domain = config.get('domain');
  else if (!domain) domain = uri.host;

  return `${uri.user || 'undefined'}@${domain}`;
};

obj.generateETag = function() {
  return uuid.new();
};


