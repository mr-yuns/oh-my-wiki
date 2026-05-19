export function parseOptions(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options._.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const inlineEqualsIndex = arg.indexOf('=');
    if (inlineEqualsIndex !== -1) {
      options[arg.slice(2, inlineEqualsIndex)] = arg.slice(inlineEqualsIndex + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

export function requireOption(options, key, usage) {
  if (!options[key]) {
    throw new Error(`${usage} requires --${key}`);
  }
  return options[key];
}
