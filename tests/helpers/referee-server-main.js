// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The reference server run from its TypeScript source in its own process (s97-m09, design §R4): a test starts it
// ABOUTME: with a config file and reads the port from its first line, as a client would reach the dashboard.
require('./ts-register');

require('./referee-server.ts')
  .main(process.argv[2])
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
