/**
 * @module registar
 *
 * In order to forward MESSAGEs, we need access to a registrar.
 * This is a test stub, used in the test cases.
 * You will need to create your own version and require it in app.js
 */

/**
 * return a Promise that resolves with the Contact of the provided AOR.
 * @param  {string} aor address of record
 * @param  {Request} req the incoming request message that will be forwarded
 * @return {Promise} a Promise that resolves with a contact
 */
module.exports = function(aor, req) {
  // for test cases, we are simply forwarding messages back to the sender
  return Promise.resolve()
    .then(() => {
      return `${req.source_address}:${req.source_port}`;
    });
};
