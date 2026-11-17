import http from 'node:http';

const DEFAULT_SPLIT_AT_BYTES = 8;

/**
 * POSTs `body` to `url`, sending the headers and its first `splitAtBytes` bytes now and holding the rest until
 * `finish()`. `status` resolves with the response status.
 */
export function pausedPost(url, { headers, body, splitAtBytes = DEFAULT_SPLIT_AT_BYTES }) {
  const request = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': body.length } });
  const status = new Promise((resolve, reject) => {
    request.on('response', (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  request.write(body.subarray(0, splitAtBytes));
  return { status, finish: () => request.end(body.subarray(splitAtBytes)) };
}
