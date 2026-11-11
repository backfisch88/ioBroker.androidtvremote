'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

describe('adapter metadata', () => {
    const io = readJson('io-package.json');
    const pkg = readJson('package.json');
    const config = readJson('admin/jsonConfig.json');

    it('versions are in sync', () => {
        assert.strictEqual(io.common.version, pkg.version);
        assert.ok(readJson('package-lock.json').version === pkg.version);
    });

    it('news for the current version exists in all languages', () => {
        const news = io.common.news[pkg.version];
        assert.ok(news, `news for ${pkg.version} missing`);
        for (const lang of LANGS) {
            assert.ok(news[lang], `news ${pkg.version} missing language ${lang}`);
        }
        for (const [version, entry] of Object.entries(io.common.news)) {
            assert.deepStrictEqual(Object.keys(entry).sort(), [...LANGS].sort(), `news ${version}`);
        }
    });

    it('runtime dependencies cover all required modules', () => {
        const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
        for (const match of main.matchAll(/require\('([^'.][^']*)'\)/g)) {
            const name = match[1];
            if (name.startsWith('node:')) {
                continue;
            }
            assert.ok(pkg.dependencies[name], `${name} missing in dependencies`);
        }
    });

    it('every native config field used by the admin UI has a default', () => {
        for (const [key, item] of Object.entries(config.items)) {
            if (['custom', 'staticText'].includes(item.type)) {
                continue;
            }
            assert.ok(key in io.native, `${key} missing in io-package.json native`);
        }
    });

    it('instanceObjects define info.connection', () => {
        assert.ok(io.instanceObjects.some(o => o._id === 'info.connection'));
    });
});

describe('admin translations', () => {
    const config = readJson('admin/jsonConfig.json');
    const keys = new Set();
    for (const item of Object.values(config.items)) {
        for (const prop of ['label', 'help', 'text']) {
            if (item[prop]) {
                keys.add(item[prop]);
            }
        }
    }

    for (const lang of LANGS) {
        it(`${lang}.json has exactly the keys used in jsonConfig.json`, () => {
            const translations = readJson(`admin/i18n/${lang}.json`);
            assert.deepStrictEqual(Object.keys(translations).sort(), [...keys].sort());
        });
    }
});
