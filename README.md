# drachtio-simple-server [![Build Status](https://secure.travis-ci.org/davehorton/drachtio-simple-server.png)](http://travis-ci.org/davehorton/drachtio-simple-server) 

A SIP Server application that implements presence and instant messaging (as per [RFC 6665](https://tools.ietf.org/html/rfc6665), [RFC 3856](https://tools.ietf.org/html/rfc3856), [RFC 3903](https://tools.ietf.org/html/rfc3903), [RFC 3428](https://tools.ietf.org/html/rfc3428)).

This application provides two functions:

* it acts as a [Notifier](https://tools.ietf.org/html/rfc6665#section-2) that manages [Subscriptions](https://tools.ietf.org/html/rfc6665#section-2) to presence data, and
* it acts as a [UAS message relay](https://tools.ietf.org/html/rfc3428#section-7) or [proxy](https://tools.ietf.org/html/rfc3428#section-6) enabling SIP-based instant messaging.

Note that this application does *not* handle or process INVITE requests: it deals only in SUBSCRIBE, NOTIFY, PUBLISH, MESSAGE, and OPTIONS requests.

## Plug-ins

Because user authentication and location will be specific to your installation, you will need to implement plug-in functions to authenticate users and retrieve location information from a registrar.

The authentication plugin uses [drachtio-mw-digest-auth](https://www.npmjs.com/package/drachtio-mw-digest-auth).  Your plugin here must simply return a sip password given a username and realm.  See [authenticate-test.js](./lib/plugins/authenticate-test.js) to see the stub used for testing to get a sense of what is needed.

The location service plugin is a function that you provide which takes an address-of-record and the incoming SIP MESSAGE request that needs to be routed and which returns a Promise that resolves in the uri to send to. See [registrar-test.js](./lib/plugins/registrar-test.js) to see the simple test stub.

## Storing Event State and Subscriptions

A redis server is used to store event state and subscriptions.  The server may be running locally or on a remote server.

## Running the app

If the app is started with no command line arguments, it will handle all of the supported request types identified above.

Alternatively, the specific requests to handle can be specified on the command line.  This allows you to run multiple applications for instance, one handling only MESSAGE requests while another handles presence:

```bash
$ npm start --message
..
$ npm start --subscribe --publish
```

## Configuration
See [default.json.example](./config/default.json.example) for an example set of configuration options.  The [config](https://www.npmjs.com/package/config) module is used for managing configuration.  You will need to create your own configuration under `config/local.json` or the like.

The following options exist:
* `drachtio`: location of the drachtio to connect to.  
Either inbound or outbound connections are supported.  See the section below for more details.
* `redis`: The location of the redis server.  
This is an object containing `address` and `port` properties.
* `supported-events`: An array of event types to supports.  These should be the event name 
as received in the SIP Event header of SUBSCRIBE and PUBLISH requests.  Note that 
while the main purpose is to support the 'presence' event package, any other event package 
can be supported by adding it to this array.
* `domain`: an optional parameter that, if provided, will be used as the SIP realm or domain 
when a SIP PUBLISH or SUBSCRIBE request is received with a dot-decimal address in the Request-URI 
instead of a domain name (some SBCs, for example, may replace the 
SIP domain with the ip address of an application server when performing load balancing).
* `methods`: options for handling PUBLISH/SUBSCRIBE/MESSAGE requests
* `methods.publish.authenticate`: if true, authenticate incoming PUBLISH requests (using digest authentication)
* `methods.publish.expires`: an object containing options for handling Expires headers in PUBLISH requests
* `methods.publish.expires.min`: minimum allowable Expires value (smaller values result in a 423 response)
* `methods.publish.expires.default`: default expires value, if no Expires header is present in request
* `methods.publish.expires.max`: maximum allowable Expires value; larger values received in the Expires
header of a request will be reduced to this value in the response.
* `methods.subscribe.authenticate`: if true, authenticate incoming SUBCRIBE requests
* `methods.subscribe.expires`: an object containing options for handling Expires headers in SUBSCRIBE requests
* `methods.subscribe.expires.min`: minimum allowable Expires value (smaller values result in a 423 response)
* `methods.subscribe.expires.default[package]`: default expires value, if no Expires header is present in request. Note that defaults are package-specific.
* `methods.subscribe.expires.max`: maximum allowable Expires value; larger values received in the Expires 
header of a request will be reduced to this value in the response.
* `methods.message.authenticate`: if true, authenticate incoming MESSAGE requests.
* `methods.message.storeAndForward`: if true, act as a UAS that stores messages when 
the receiving party is offline and then forward them later when it comes online.
If not specified (or set to non-truthy value), then act as a simple message proxy
(i.e. returning any failure response directly to the sender).
* `methods.message.expiry`: the number of seconds after which to discard a stored message if
it has not been delivered when acting as a store-and-forward UAS.

### drachtio connection options

To make an inbound connection to a drachtio server, specify `host`, `port` (the admin port of the drachtio server), and `secret`, e.g.:
```js
"drachtio": {
  "host": "127.0.0.1",
  "port": 9022,
  "secret": "cymru"
}
```
To receive outbound connections from a drachtio server, specify `port` (the local port to listen on for connections), and `secret`, e.g.:
```js
"drachtio": {
  "port": 3000,
  "secret": "cymru"
}
```

## Tests
There are a full set of test cases.  Docker is required to run them.
```bash
$ npm test
```

