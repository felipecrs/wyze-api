import { WyzeAPI } from '../src/index.js';

import type { WyzeAPIOptions } from '../src/types.js';

const options: WyzeAPIOptions = {
  username: 'seyd55@outlook.de',
  password: 'Samsun551991!s8',
  keyId: 'eb161863-b181-4650-b792-8f69a6b70107',
  apiKey: 'roTRg3tiuL3TjXhmDSrcVv9ChlNHL4EoIVnlxhoFwuLPyyMOmT70TLFGRdgF',
};

console.log(`Starting WyzeAPI with options: ${JSON.stringify(options)}`);

const wyze = new WyzeAPI(options);

async function deviceListCheck() {
  const devices = await wyze.getDeviceList();
  console.log(JSON.stringify(devices));
}

(async () => {
  await wyze.maybeLogin();
  await deviceListCheck();
  // await loginCheck(4);
})();
