const parseUri = require('drachtio-srf').parseUri;
const config = require('config');
const uuid = require('short-uuid')('123456789');
const _ = require('lodash');
const debug = require('debug')('drachtio:simple-server');

const obj = module.exports = {};

obj.parseAor = function(u) {
  const uri = parseUri(u);
  let domain = uri.host.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
  if (domain && config.has('domain')) domain = config.get('domain');
  else if (!domain) domain = uri.host;

  return `${uri.user || 'undefined'}@${domain}`;
};

obj.generateETag = function() {
  return uuid.new();
};

obj.parseEventHeader = function(event) {
  const arr = /^(.*);(.*)$/.exec(event);
  if (!arr) {
    //Event: foo
    return { event };
  }

  const obj = {event: arr[1].trim()};
  const idMatch = /id=([^//s;]*)/.exec(arr[2]);
  if (idMatch) obj.id = idMatch[1];

  debug(`parseEventHeader: Event header ${event} parsed as ${JSON.stringify(obj)}`);

  return obj;
};

obj.getDefaultSubscriptionExpiry = function(package) {
  if (!config.has('methods.subscribe.expire.default')) return 3600;
  const obj = _.find(config.get('methods.subscribe.expire.default'), (o, k) => {return k === package;});
  if (!obj) return 3600;
  return obj.expires;
};

