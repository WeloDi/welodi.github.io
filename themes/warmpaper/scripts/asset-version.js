const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CSS_FILE = path.join(__dirname, '..', 'source', 'css', 'style.css');

function readCssVersion() {
  try {
    return crypto
      .createHash('sha1')
      .update(fs.readFileSync(CSS_FILE))
      .digest('hex')
      .slice(0, 8);
  } catch (err) {
    return String(Date.now());
  }
}

hexo.extend.helper.register('css_version', readCssVersion);
