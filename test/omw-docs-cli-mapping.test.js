import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/omw.js');

test('README command table and CLI help stay bidirectionally mapped', async () => {
  const [readme, help, wikiHelp] = await Promise.all([
    readFile('README.md', 'utf8'),
    execFileAsync(process.execPath, [cliPath, '--help']).then((result) => result.stdout),
    execFileAsync(process.execPath, [cliPath, 'wiki', '--help']).then((result) => result.stdout),
  ]);
  const tableCommands = readmeCommandTable(readme);
  const tableStems = new Set(tableCommands.map(commandStem).filter(Boolean));
  const helpStems = new Set([...usageCommandStems(help), ...usageCommandStems(wikiHelp)].filter(Boolean));
  const passthroughLaunchCommand = 'omw <omx launch flags>';

  for (const command of helpStems) {
    assert(tableStems.has(command), `README command table is missing help command ${command}`);
  }
  for (const command of tableStems) {
    assert(helpStems.has(command), `README command table entry has no CLI help coverage: ${command}`);
  }
  assert(help.includes('omw <omx launch flags...>'));
  assert(tableCommands.some((entry) => commandStem(entry) === passthroughLaunchCommand), `README command table is missing help command ${passthroughLaunchCommand}`);
  assertReadmeOptionCoverage({ help, tableCommands });
  assertReadmeOptionCoverage({ help: wikiHelp, tableCommands });
  assertSearchAliasOptionParity({ readme, help, wikiHelp, tableCommands });
  assertOptionParity({ tableCommands, help, command: 'omw queue', expectedOptions: ['--json'] });
  assertOptionParity({ tableCommands, help: wikiHelp, command: 'omw wiki queue', expectedOptions: ['--json'] });
  assertOptionParity({
    tableCommands,
    help,
    command: 'omw capture',
    expectedOptions: ['--title', '--type', '--stdin', '--body', '--dry-run', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help: wikiHelp,
    command: 'omw wiki capture',
    expectedOptions: ['--title', '--type', '--stdin', '--body', '--dry-run', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help,
    command: 'omw ingest',
    expectedOptions: ['--write-draft', '--overwrite-draft', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help: wikiHelp,
    command: 'omw wiki ingest',
    expectedOptions: ['--write-draft', '--overwrite-draft', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help,
    command: 'omw ingest',
    requiredHelpFragment: '--promote',
    requiredReadmeFragment: '--promote',
    expectedOptions: ['--promote', '--target', '--overwrite-promote', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help: wikiHelp,
    command: 'omw wiki ingest',
    requiredHelpFragment: '--promote',
    requiredReadmeFragment: '--promote',
    expectedOptions: ['--promote', '--target', '--overwrite-promote', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help,
    command: 'omw daily',
    expectedOptions: ['--author', '--team', '--date', '--stdin', '--body', '--dry-run', '--json'],
  });
  assertOptionParity({
    tableCommands,
    help: wikiHelp,
    command: 'omw wiki daily',
    expectedOptions: ['--author', '--team', '--date', '--stdin', '--body', '--dry-run', '--json'],
  });
  assert(readme.includes('understanding score'));
  assert(readme.includes('Wiki-specific Deep Interview'));
  assert(help.includes('Active wiki: OMW_WIKI_PATH, saved config, then repository .wiki'));
});

function readmeCommandTable(readme) {
  const section = readme.match(/## Commands\n\n([\s\S]*?)\n## /)?.[1] || '';
  return section
    .split('\n')
    .map((line) => line.match(/^\|\s+`([^`]+)`\s+\|/)?.[1])
    .filter(Boolean);
}

function usageCommandStems(help) {
  return help
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('omw '))
    .flatMap((line) => (line.startsWith('omw <omx launch flags') ? ['omw <omx launch flags>'] : expandCommandAlternatives(line)))
    .map(commandStem)
    .filter((stem) => stem && stem !== 'omw');
}

function expandCommandAlternatives(line) {
  const tokens = line.split(/\s+/);
  const commandTokens = [];
  for (const token of tokens) {
    if (token.startsWith('[') || token.startsWith('"') || token.startsWith('<')) break;
    if (token.startsWith('--') && token !== '--') break;
    commandTokens.push(token);
  }
  return expandTokens(commandTokens).map((tokens) => tokens.join(' '));
}

function expandTokens(tokens) {
  return tokens.reduce((variants, token) => {
    const options = token.includes('|') ? token.split('|') : [token];
    return variants.flatMap((variant) => options.map((option) => [...variant, option]));
  }, [[]]);
}

function commandStem(command) {
  if (String(command || '').startsWith('omw <omx launch flags')) {
    return 'omw <omx launch flags>';
  }
  const withoutOptions = String(command || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  const tokenList = withoutOptions.split(/\s+/).filter(Boolean);
  const out = [];
  for (const token of tokenList) {
    if (token.startsWith('--') && token !== '--') break;
    out.push(token);
  }
  return out.join(' ');
}

function assertSearchAliasOptionParity({ readme, help, wikiHelp, tableCommands }) {
  const expectedOptions = ['--backend', '--limit', '--type', '--status', '--path', '--sort', '--json'];
  const topHelpLine = usageLine(help, 'omw search "<query>"');
  const wikiHelpLine = usageLine(wikiHelp, 'omw wiki search "<query>"');
  const topReadmeRow = tableCommands.find((entry) => entry.startsWith('omw search "<query>"')) || '';
  const wikiReadmeRow = tableCommands.find((entry) => entry.startsWith('omw wiki search "<query>"')) || '';

  for (const option of expectedOptions) {
    assert(topHelpLine.includes(option), `top-level omw search help is missing ${option}`);
    assert(wikiHelpLine.includes(option), `wiki search help is missing ${option}`);
    assert(topReadmeRow.includes(option) || readme.includes(`Alias for \`omw wiki search\`; supports`), `README omw search row is missing alias option coverage for ${option}`);
    assert(wikiReadmeRow.includes(option) || readme.includes(`Search wiki notes through the wiki command group; supports`), `README omw wiki search row is missing option coverage for ${option}`);
  }
}

function assertReadmeOptionCoverage({ help, tableCommands }) {
  for (const line of helpUsageLines(help)) {
    const command = commandStem(line);
    if (!command || command === 'omw') continue;
    if (command.includes('|')) continue;
    const expectedOptions = optionTokens(line);
    if (expectedOptions.length === 0) continue;
    const readmeRow = matchingReadmeRow({ line, command, tableCommands });
    assert(readmeRow, `README command table is missing ${command}`);
    for (const option of expectedOptions) {
      assert(readmeRow.includes(option), `README ${command} row is missing ${option}`);
    }
  }
}

function assertOptionParity({ tableCommands, help, command, expectedOptions, requiredHelpFragment = '', requiredReadmeFragment = '' }) {
  const helpLine = usageLine(help, command, requiredHelpFragment);
  const readmeRow = tableCommands.find((entry) => commandStem(entry) === command && entry.includes(requiredReadmeFragment)) || '';
  assert(helpLine, `CLI help is missing ${command}`);
  assert(readmeRow, `README command table is missing ${command}`);
  for (const option of expectedOptions) {
    assert(helpLine.includes(option), `${command} help is missing ${option}`);
    assert(readmeRow.includes(option), `README ${command} row is missing ${option}`);
  }
}

function helpUsageLines(help) {
  return help
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('omw '));
}

function optionTokens(command) {
  return [...new Set(String(command || '').match(/--[a-z0-9-]+/g) || [])];
}

function matchingReadmeRow({ line, command, tableCommands }) {
  const requiredFragment = line.includes('--promote') ? '--promote' : '';
  return tableCommands.find((entry) => commandStem(entry) === command && entry.includes(requiredFragment)) || '';
}

function usageLine(help, stem, requiredFragment = '') {
  return help
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(stem) && line.includes(requiredFragment)) || '';
}
