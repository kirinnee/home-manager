#!/usr/bin/env bun
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === 'object';
  if (canCache) {
    var cache = isNodeMode ? (__toESMCache_node ??= new WeakMap()) : (__toESMCache_esm ??= new WeakMap());
    var cached = cache.get(mod);
    if (cached) return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to =
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, 'default', { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true,
      });
  if (canCache) cache.set(mod, to);
  return to;
};
var __toCommonJS = from => {
  var entry = (__moduleCache ??= new WeakMap()).get(from),
    desc;
  if (entry) return entry;
  entry = __defProp({}, '__esModule', { value: true });
  if ((from && typeof from === 'object') || typeof from === 'function') {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = v => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name),
    });
};
var __esm = (fn, res) => () => (fn && (res = fn((fn = 0))), res);
var __require = import.meta.require;

// node_modules/commander/lib/error.js
var require_error = __commonJS(exports => {
  class CommanderError extends Error {
    constructor(exitCode, code, message) {
      super(message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
      this.code = code;
      this.exitCode = exitCode;
      this.nestedError = undefined;
    }
  }

  class InvalidArgumentError extends CommanderError {
    constructor(message) {
      super(1, 'commander.invalidArgument', message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
    }
  }
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS(exports => {
  var { InvalidArgumentError } = require_error();

  class Argument {
    constructor(name, description) {
      this.description = description || '';
      this.variadic = false;
      this.parseArg = undefined;
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.argChoices = undefined;
      switch (name[0]) {
        case '<':
          this.required = true;
          this._name = name.slice(1, -1);
          break;
        case '[':
          this.required = false;
          this._name = name.slice(1, -1);
          break;
        default:
          this.required = true;
          this._name = name;
          break;
      }
      if (this._name.length > 3 && this._name.slice(-3) === '...') {
        this.variadic = true;
        this._name = this._name.slice(0, -3);
      }
    }
    name() {
      return this._name;
    }
    _concatValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      return previous.concat(value);
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(', ')}.`);
        }
        if (this.variadic) {
          return this._concatValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    argRequired() {
      this.required = true;
      return this;
    }
    argOptional() {
      this.required = false;
      return this;
    }
  }
  function humanReadableArgName(arg) {
    const nameOutput = arg.name() + (arg.variadic === true ? '...' : '');
    return arg.required ? '<' + nameOutput + '>' : '[' + nameOutput + ']';
  }
  exports.Argument = Argument;
  exports.humanReadableArgName = humanReadableArgName;
});

// node_modules/commander/lib/help.js
var require_help = __commonJS(exports => {
  var { humanReadableArgName } = require_argument();

  class Help {
    constructor() {
      this.helpWidth = undefined;
      this.sortSubcommands = false;
      this.sortOptions = false;
      this.showGlobalOptions = false;
    }
    visibleCommands(cmd) {
      const visibleCommands = cmd.commands.filter(cmd2 => !cmd2._hidden);
      const helpCommand = cmd._getHelpCommand();
      if (helpCommand && !helpCommand._hidden) {
        visibleCommands.push(helpCommand);
      }
      if (this.sortSubcommands) {
        visibleCommands.sort((a, b) => {
          return a.name().localeCompare(b.name());
        });
      }
      return visibleCommands;
    }
    compareOptions(a, b) {
      const getSortKey = option => {
        return option.short ? option.short.replace(/^-/, '') : option.long.replace(/^--/, '');
      };
      return getSortKey(a).localeCompare(getSortKey(b));
    }
    visibleOptions(cmd) {
      const visibleOptions = cmd.options.filter(option => !option.hidden);
      const helpOption = cmd._getHelpOption();
      if (helpOption && !helpOption.hidden) {
        const removeShort = helpOption.short && cmd._findOption(helpOption.short);
        const removeLong = helpOption.long && cmd._findOption(helpOption.long);
        if (!removeShort && !removeLong) {
          visibleOptions.push(helpOption);
        } else if (helpOption.long && !removeLong) {
          visibleOptions.push(cmd.createOption(helpOption.long, helpOption.description));
        } else if (helpOption.short && !removeShort) {
          visibleOptions.push(cmd.createOption(helpOption.short, helpOption.description));
        }
      }
      if (this.sortOptions) {
        visibleOptions.sort(this.compareOptions);
      }
      return visibleOptions;
    }
    visibleGlobalOptions(cmd) {
      if (!this.showGlobalOptions) return [];
      const globalOptions = [];
      for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        const visibleOptions = ancestorCmd.options.filter(option => !option.hidden);
        globalOptions.push(...visibleOptions);
      }
      if (this.sortOptions) {
        globalOptions.sort(this.compareOptions);
      }
      return globalOptions;
    }
    visibleArguments(cmd) {
      if (cmd._argsDescription) {
        cmd.registeredArguments.forEach(argument => {
          argument.description = argument.description || cmd._argsDescription[argument.name()] || '';
        });
      }
      if (cmd.registeredArguments.find(argument => argument.description)) {
        return cmd.registeredArguments;
      }
      return [];
    }
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments.map(arg => humanReadableArgName(arg)).join(' ');
      return (
        cmd._name +
        (cmd._aliases[0] ? '|' + cmd._aliases[0] : '') +
        (cmd.options.length ? ' [options]' : '') +
        (args ? ' ' + args : '')
      );
    }
    optionTerm(option) {
      return option.flags;
    }
    argumentTerm(argument) {
      return argument.name();
    }
    longestSubcommandTermLength(cmd, helper) {
      return helper.visibleCommands(cmd).reduce((max, command) => {
        return Math.max(max, helper.subcommandTerm(command).length);
      }, 0);
    }
    longestOptionTermLength(cmd, helper) {
      return helper.visibleOptions(cmd).reduce((max, option) => {
        return Math.max(max, helper.optionTerm(option).length);
      }, 0);
    }
    longestGlobalOptionTermLength(cmd, helper) {
      return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
        return Math.max(max, helper.optionTerm(option).length);
      }, 0);
    }
    longestArgumentTermLength(cmd, helper) {
      return helper.visibleArguments(cmd).reduce((max, argument) => {
        return Math.max(max, helper.argumentTerm(argument).length);
      }, 0);
    }
    commandUsage(cmd) {
      let cmdName = cmd._name;
      if (cmd._aliases[0]) {
        cmdName = cmdName + '|' + cmd._aliases[0];
      }
      let ancestorCmdNames = '';
      for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        ancestorCmdNames = ancestorCmd.name() + ' ' + ancestorCmdNames;
      }
      return ancestorCmdNames + cmdName + ' ' + cmd.usage();
    }
    commandDescription(cmd) {
      return cmd.description();
    }
    subcommandDescription(cmd) {
      return cmd.summary() || cmd.description();
    }
    optionDescription(option) {
      const extraInfo = [];
      if (option.argChoices) {
        extraInfo.push(`choices: ${option.argChoices.map(choice => JSON.stringify(choice)).join(', ')}`);
      }
      if (option.defaultValue !== undefined) {
        const showDefault =
          option.required || option.optional || (option.isBoolean() && typeof option.defaultValue === 'boolean');
        if (showDefault) {
          extraInfo.push(`default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
        }
      }
      if (option.presetArg !== undefined && option.optional) {
        extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
      }
      if (option.envVar !== undefined) {
        extraInfo.push(`env: ${option.envVar}`);
      }
      if (extraInfo.length > 0) {
        return `${option.description} (${extraInfo.join(', ')})`;
      }
      return option.description;
    }
    argumentDescription(argument) {
      const extraInfo = [];
      if (argument.argChoices) {
        extraInfo.push(`choices: ${argument.argChoices.map(choice => JSON.stringify(choice)).join(', ')}`);
      }
      if (argument.defaultValue !== undefined) {
        extraInfo.push(`default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`);
      }
      if (extraInfo.length > 0) {
        const extraDescripton = `(${extraInfo.join(', ')})`;
        if (argument.description) {
          return `${argument.description} ${extraDescripton}`;
        }
        return extraDescripton;
      }
      return argument.description;
    }
    formatHelp(cmd, helper) {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth || 80;
      const itemIndentWidth = 2;
      const itemSeparatorWidth = 2;
      function formatItem(term, description) {
        if (description) {
          const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
          return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
        }
        return term;
      }
      function formatList(textArray) {
        return textArray
          .join(
            `
`,
          )
          .replace(/^/gm, ' '.repeat(itemIndentWidth));
      }
      let output = [`Usage: ${helper.commandUsage(cmd)}`, ''];
      const commandDescription = helper.commandDescription(cmd);
      if (commandDescription.length > 0) {
        output = output.concat([helper.wrap(commandDescription, helpWidth, 0), '']);
      }
      const argumentList = helper.visibleArguments(cmd).map(argument => {
        return formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument));
      });
      if (argumentList.length > 0) {
        output = output.concat(['Arguments:', formatList(argumentList), '']);
      }
      const optionList = helper.visibleOptions(cmd).map(option => {
        return formatItem(helper.optionTerm(option), helper.optionDescription(option));
      });
      if (optionList.length > 0) {
        output = output.concat(['Options:', formatList(optionList), '']);
      }
      if (this.showGlobalOptions) {
        const globalOptionList = helper.visibleGlobalOptions(cmd).map(option => {
          return formatItem(helper.optionTerm(option), helper.optionDescription(option));
        });
        if (globalOptionList.length > 0) {
          output = output.concat(['Global Options:', formatList(globalOptionList), '']);
        }
      }
      const commandList = helper.visibleCommands(cmd).map(cmd2 => {
        return formatItem(helper.subcommandTerm(cmd2), helper.subcommandDescription(cmd2));
      });
      if (commandList.length > 0) {
        output = output.concat(['Commands:', formatList(commandList), '']);
      }
      return output.join(`
`);
    }
    padWidth(cmd, helper) {
      return Math.max(
        helper.longestOptionTermLength(cmd, helper),
        helper.longestGlobalOptionTermLength(cmd, helper),
        helper.longestSubcommandTermLength(cmd, helper),
        helper.longestArgumentTermLength(cmd, helper),
      );
    }
    wrap(str, width, indent, minColumnWidth = 40) {
      const indents = ' \\f\\t\\v\xA0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF';
      const manualIndent = new RegExp(`[\\n][${indents}]+`);
      if (str.match(manualIndent)) return str;
      const columnWidth = width - indent;
      if (columnWidth < minColumnWidth) return str;
      const leadingStr = str.slice(0, indent);
      const columnText = str.slice(indent).replace(
        `\r
`,
        `
`,
      );
      const indentString = ' '.repeat(indent);
      const zeroWidthSpace = '\u200B';
      const breaks = `\\s${zeroWidthSpace}`;
      const regex = new RegExp(
        `
|.{1,${columnWidth - 1}}([${breaks}]|$)|[^${breaks}]+?([${breaks}]|$)`,
        'g',
      );
      const lines = columnText.match(regex) || [];
      return (
        leadingStr +
        lines.map((line, i) => {
          if (
            line ===
            `
`
          )
            return '';
          return (i > 0 ? indentString : '') + line.trimEnd();
        }).join(`
`)
      );
    }
  }
  exports.Help = Help;
});

// node_modules/commander/lib/option.js
var require_option = __commonJS(exports => {
  var { InvalidArgumentError } = require_error();

  class Option {
    constructor(flags, description) {
      this.flags = flags;
      this.description = description || '';
      this.required = flags.includes('<');
      this.optional = flags.includes('[');
      this.variadic = /\w\.\.\.[>\]]$/.test(flags);
      this.mandatory = false;
      const optionFlags = splitOptionFlags(flags);
      this.short = optionFlags.shortFlag;
      this.long = optionFlags.longFlag;
      this.negate = false;
      if (this.long) {
        this.negate = this.long.startsWith('--no-');
      }
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.presetArg = undefined;
      this.envVar = undefined;
      this.parseArg = undefined;
      this.hidden = false;
      this.argChoices = undefined;
      this.conflictsWith = [];
      this.implied = undefined;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    preset(arg) {
      this.presetArg = arg;
      return this;
    }
    conflicts(names) {
      this.conflictsWith = this.conflictsWith.concat(names);
      return this;
    }
    implies(impliedOptionValues) {
      let newImplied = impliedOptionValues;
      if (typeof impliedOptionValues === 'string') {
        newImplied = { [impliedOptionValues]: true };
      }
      this.implied = Object.assign(this.implied || {}, newImplied);
      return this;
    }
    env(name) {
      this.envVar = name;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    makeOptionMandatory(mandatory = true) {
      this.mandatory = !!mandatory;
      return this;
    }
    hideHelp(hide = true) {
      this.hidden = !!hide;
      return this;
    }
    _concatValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      return previous.concat(value);
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(', ')}.`);
        }
        if (this.variadic) {
          return this._concatValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    name() {
      if (this.long) {
        return this.long.replace(/^--/, '');
      }
      return this.short.replace(/^-/, '');
    }
    attributeName() {
      return camelcase(this.name().replace(/^no-/, ''));
    }
    is(arg) {
      return this.short === arg || this.long === arg;
    }
    isBoolean() {
      return !this.required && !this.optional && !this.negate;
    }
  }

  class DualOptions {
    constructor(options) {
      this.positiveOptions = new Map();
      this.negativeOptions = new Map();
      this.dualOptions = new Set();
      options.forEach(option => {
        if (option.negate) {
          this.negativeOptions.set(option.attributeName(), option);
        } else {
          this.positiveOptions.set(option.attributeName(), option);
        }
      });
      this.negativeOptions.forEach((value, key) => {
        if (this.positiveOptions.has(key)) {
          this.dualOptions.add(key);
        }
      });
    }
    valueFromOption(value, option) {
      const optionKey = option.attributeName();
      if (!this.dualOptions.has(optionKey)) return true;
      const preset = this.negativeOptions.get(optionKey).presetArg;
      const negativeValue = preset !== undefined ? preset : false;
      return option.negate === (negativeValue === value);
    }
  }
  function camelcase(str) {
    return str.split('-').reduce((str2, word) => {
      return str2 + word[0].toUpperCase() + word.slice(1);
    });
  }
  function splitOptionFlags(flags) {
    let shortFlag;
    let longFlag;
    const flagParts = flags.split(/[ |,]+/);
    if (flagParts.length > 1 && !/^[[<]/.test(flagParts[1])) shortFlag = flagParts.shift();
    longFlag = flagParts.shift();
    if (!shortFlag && /^-[^-]$/.test(longFlag)) {
      shortFlag = longFlag;
      longFlag = undefined;
    }
    return { shortFlag, longFlag };
  }
  exports.Option = Option;
  exports.DualOptions = DualOptions;
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS(exports => {
  var maxDistance = 3;
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > maxDistance) return Math.max(a.length, b.length);
    const d = [];
    for (let i = 0; i <= a.length; i++) {
      d[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
      d[0][j] = j;
    }
    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        let cost = 1;
        if (a[i - 1] === b[j - 1]) {
          cost = 0;
        } else {
          cost = 1;
        }
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }
  function suggestSimilar(word, candidates) {
    if (!candidates || candidates.length === 0) return '';
    candidates = Array.from(new Set(candidates));
    const searchingOptions = word.startsWith('--');
    if (searchingOptions) {
      word = word.slice(2);
      candidates = candidates.map(candidate => candidate.slice(2));
    }
    let similar = [];
    let bestDistance = maxDistance;
    const minSimilarity = 0.4;
    candidates.forEach(candidate => {
      if (candidate.length <= 1) return;
      const distance = editDistance(word, candidate);
      const length = Math.max(word.length, candidate.length);
      const similarity = (length - distance) / length;
      if (similarity > minSimilarity) {
        if (distance < bestDistance) {
          bestDistance = distance;
          similar = [candidate];
        } else if (distance === bestDistance) {
          similar.push(candidate);
        }
      }
    });
    similar.sort((a, b) => a.localeCompare(b));
    if (searchingOptions) {
      similar = similar.map(candidate => `--${candidate}`);
    }
    if (similar.length > 1) {
      return `
(Did you mean one of ${similar.join(', ')}?)`;
    }
    if (similar.length === 1) {
      return `
(Did you mean ${similar[0]}?)`;
    }
    return '';
  }
  exports.suggestSimilar = suggestSimilar;
});

// node_modules/commander/lib/command.js
var require_command = __commonJS(exports => {
  var EventEmitter = __require('events').EventEmitter;
  var childProcess = __require('child_process');
  var path = __require('path');
  var fs = __require('fs');
  var process2 = __require('process');
  var { Argument, humanReadableArgName } = require_argument();
  var { CommanderError } = require_error();
  var { Help } = require_help();
  var { Option, DualOptions } = require_option();
  var { suggestSimilar } = require_suggestSimilar();

  class Command extends EventEmitter {
    constructor(name) {
      super();
      this.commands = [];
      this.options = [];
      this.parent = null;
      this._allowUnknownOption = false;
      this._allowExcessArguments = true;
      this.registeredArguments = [];
      this._args = this.registeredArguments;
      this.args = [];
      this.rawArgs = [];
      this.processedArgs = [];
      this._scriptPath = null;
      this._name = name || '';
      this._optionValues = {};
      this._optionValueSources = {};
      this._storeOptionsAsProperties = false;
      this._actionHandler = null;
      this._executableHandler = false;
      this._executableFile = null;
      this._executableDir = null;
      this._defaultCommandName = null;
      this._exitCallback = null;
      this._aliases = [];
      this._combineFlagAndOptionalValue = true;
      this._description = '';
      this._summary = '';
      this._argsDescription = undefined;
      this._enablePositionalOptions = false;
      this._passThroughOptions = false;
      this._lifeCycleHooks = {};
      this._showHelpAfterError = false;
      this._showSuggestionAfterError = true;
      this._outputConfiguration = {
        writeOut: str => process2.stdout.write(str),
        writeErr: str => process2.stderr.write(str),
        getOutHelpWidth: () => (process2.stdout.isTTY ? process2.stdout.columns : undefined),
        getErrHelpWidth: () => (process2.stderr.isTTY ? process2.stderr.columns : undefined),
        outputError: (str, write) => write(str),
      };
      this._hidden = false;
      this._helpOption = undefined;
      this._addImplicitHelpCommand = undefined;
      this._helpCommand = undefined;
      this._helpConfiguration = {};
    }
    copyInheritedSettings(sourceCommand) {
      this._outputConfiguration = sourceCommand._outputConfiguration;
      this._helpOption = sourceCommand._helpOption;
      this._helpCommand = sourceCommand._helpCommand;
      this._helpConfiguration = sourceCommand._helpConfiguration;
      this._exitCallback = sourceCommand._exitCallback;
      this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
      this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
      this._allowExcessArguments = sourceCommand._allowExcessArguments;
      this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
      this._showHelpAfterError = sourceCommand._showHelpAfterError;
      this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
      return this;
    }
    _getCommandAndAncestors() {
      const result = [];
      for (let command = this; command; command = command.parent) {
        result.push(command);
      }
      return result;
    }
    command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
      let desc = actionOptsOrExecDesc;
      let opts = execOpts;
      if (typeof desc === 'object' && desc !== null) {
        opts = desc;
        desc = null;
      }
      opts = opts || {};
      const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const cmd = this.createCommand(name);
      if (desc) {
        cmd.description(desc);
        cmd._executableHandler = true;
      }
      if (opts.isDefault) this._defaultCommandName = cmd._name;
      cmd._hidden = !!(opts.noHelp || opts.hidden);
      cmd._executableFile = opts.executableFile || null;
      if (args) cmd.arguments(args);
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd.copyInheritedSettings(this);
      if (desc) return this;
      return cmd;
    }
    createCommand(name) {
      return new Command(name);
    }
    createHelp() {
      return Object.assign(new Help(), this.configureHelp());
    }
    configureHelp(configuration) {
      if (configuration === undefined) return this._helpConfiguration;
      this._helpConfiguration = configuration;
      return this;
    }
    configureOutput(configuration) {
      if (configuration === undefined) return this._outputConfiguration;
      Object.assign(this._outputConfiguration, configuration);
      return this;
    }
    showHelpAfterError(displayHelp = true) {
      if (typeof displayHelp !== 'string') displayHelp = !!displayHelp;
      this._showHelpAfterError = displayHelp;
      return this;
    }
    showSuggestionAfterError(displaySuggestion = true) {
      this._showSuggestionAfterError = !!displaySuggestion;
      return this;
    }
    addCommand(cmd, opts) {
      if (!cmd._name) {
        throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
      }
      opts = opts || {};
      if (opts.isDefault) this._defaultCommandName = cmd._name;
      if (opts.noHelp || opts.hidden) cmd._hidden = true;
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd._checkForBrokenPassThrough();
      return this;
    }
    createArgument(name, description) {
      return new Argument(name, description);
    }
    argument(name, description, fn, defaultValue) {
      const argument = this.createArgument(name, description);
      if (typeof fn === 'function') {
        argument.default(defaultValue).argParser(fn);
      } else {
        argument.default(fn);
      }
      this.addArgument(argument);
      return this;
    }
    arguments(names) {
      names
        .trim()
        .split(/ +/)
        .forEach(detail => {
          this.argument(detail);
        });
      return this;
    }
    addArgument(argument) {
      const previousArgument = this.registeredArguments.slice(-1)[0];
      if (previousArgument && previousArgument.variadic) {
        throw new Error(`only the last argument can be variadic '${previousArgument.name()}'`);
      }
      if (argument.required && argument.defaultValue !== undefined && argument.parseArg === undefined) {
        throw new Error(`a default value for a required argument is never used: '${argument.name()}'`);
      }
      this.registeredArguments.push(argument);
      return this;
    }
    helpCommand(enableOrNameAndArgs, description) {
      if (typeof enableOrNameAndArgs === 'boolean') {
        this._addImplicitHelpCommand = enableOrNameAndArgs;
        return this;
      }
      enableOrNameAndArgs = enableOrNameAndArgs ?? 'help [command]';
      const [, helpName, helpArgs] = enableOrNameAndArgs.match(/([^ ]+) *(.*)/);
      const helpDescription = description ?? 'display help for command';
      const helpCommand = this.createCommand(helpName);
      helpCommand.helpOption(false);
      if (helpArgs) helpCommand.arguments(helpArgs);
      if (helpDescription) helpCommand.description(helpDescription);
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      return this;
    }
    addHelpCommand(helpCommand, deprecatedDescription) {
      if (typeof helpCommand !== 'object') {
        this.helpCommand(helpCommand, deprecatedDescription);
        return this;
      }
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      return this;
    }
    _getHelpCommand() {
      const hasImplicitHelpCommand =
        this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand('help'));
      if (hasImplicitHelpCommand) {
        if (this._helpCommand === undefined) {
          this.helpCommand(undefined, undefined);
        }
        return this._helpCommand;
      }
      return null;
    }
    hook(event, listener) {
      const allowedValues = ['preSubcommand', 'preAction', 'postAction'];
      if (!allowedValues.includes(event)) {
        throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      if (this._lifeCycleHooks[event]) {
        this._lifeCycleHooks[event].push(listener);
      } else {
        this._lifeCycleHooks[event] = [listener];
      }
      return this;
    }
    exitOverride(fn) {
      if (fn) {
        this._exitCallback = fn;
      } else {
        this._exitCallback = err => {
          if (err.code !== 'commander.executeSubCommandAsync') {
            throw err;
          } else {
          }
        };
      }
      return this;
    }
    _exit(exitCode, code, message) {
      if (this._exitCallback) {
        this._exitCallback(new CommanderError(exitCode, code, message));
      }
      process2.exit(exitCode);
    }
    action(fn) {
      const listener = args => {
        const expectedArgsCount = this.registeredArguments.length;
        const actionArgs = args.slice(0, expectedArgsCount);
        if (this._storeOptionsAsProperties) {
          actionArgs[expectedArgsCount] = this;
        } else {
          actionArgs[expectedArgsCount] = this.opts();
        }
        actionArgs.push(this);
        return fn.apply(this, actionArgs);
      };
      this._actionHandler = listener;
      return this;
    }
    createOption(flags, description) {
      return new Option(flags, description);
    }
    _callParseArg(target, value, previous, invalidArgumentMessage) {
      try {
        return target.parseArg(value, previous);
      } catch (err) {
        if (err.code === 'commander.invalidArgument') {
          const message = `${invalidArgumentMessage} ${err.message}`;
          this.error(message, { exitCode: err.exitCode, code: err.code });
        }
        throw err;
      }
    }
    _registerOption(option) {
      const matchingOption =
        (option.short && this._findOption(option.short)) || (option.long && this._findOption(option.long));
      if (matchingOption) {
        const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
        throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
      }
      this.options.push(option);
    }
    _registerCommand(command) {
      const knownBy = cmd => {
        return [cmd.name()].concat(cmd.aliases());
      };
      const alreadyUsed = knownBy(command).find(name => this._findCommand(name));
      if (alreadyUsed) {
        const existingCmd = knownBy(this._findCommand(alreadyUsed)).join('|');
        const newCmd = knownBy(command).join('|');
        throw new Error(`cannot add command '${newCmd}' as already have command '${existingCmd}'`);
      }
      this.commands.push(command);
    }
    addOption(option) {
      this._registerOption(option);
      const oname = option.name();
      const name = option.attributeName();
      if (option.negate) {
        const positiveLongFlag = option.long.replace(/^--no-/, '--');
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(
            name,
            option.defaultValue === undefined ? true : option.defaultValue,
            'default',
          );
        }
      } else if (option.defaultValue !== undefined) {
        this.setOptionValueWithSource(name, option.defaultValue, 'default');
      }
      const handleOptionValue = (val, invalidValueMessage, valueSource) => {
        if (val == null && option.presetArg !== undefined) {
          val = option.presetArg;
        }
        const oldValue = this.getOptionValue(name);
        if (val !== null && option.parseArg) {
          val = this._callParseArg(option, val, oldValue, invalidValueMessage);
        } else if (val !== null && option.variadic) {
          val = option._concatValue(val, oldValue);
        }
        if (val == null) {
          if (option.negate) {
            val = false;
          } else if (option.isBoolean() || option.optional) {
            val = true;
          } else {
            val = '';
          }
        }
        this.setOptionValueWithSource(name, val, valueSource);
      };
      this.on('option:' + oname, val => {
        const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, 'cli');
      });
      if (option.envVar) {
        this.on('optionEnv:' + oname, val => {
          const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, 'env');
        });
      }
      return this;
    }
    _optionEx(config, flags, description, fn, defaultValue) {
      if (typeof flags === 'object' && flags instanceof Option) {
        throw new Error('To add an Option object use addOption() instead of option() or requiredOption()');
      }
      const option = this.createOption(flags, description);
      option.makeOptionMandatory(!!config.mandatory);
      if (typeof fn === 'function') {
        option.default(defaultValue).argParser(fn);
      } else if (fn instanceof RegExp) {
        const regex = fn;
        fn = (val, def) => {
          const m = regex.exec(val);
          return m ? m[0] : def;
        };
        option.default(defaultValue).argParser(fn);
      } else {
        option.default(fn);
      }
      return this.addOption(option);
    }
    option(flags, description, parseArg, defaultValue) {
      return this._optionEx({}, flags, description, parseArg, defaultValue);
    }
    requiredOption(flags, description, parseArg, defaultValue) {
      return this._optionEx({ mandatory: true }, flags, description, parseArg, defaultValue);
    }
    combineFlagAndOptionalValue(combine = true) {
      this._combineFlagAndOptionalValue = !!combine;
      return this;
    }
    allowUnknownOption(allowUnknown = true) {
      this._allowUnknownOption = !!allowUnknown;
      return this;
    }
    allowExcessArguments(allowExcess = true) {
      this._allowExcessArguments = !!allowExcess;
      return this;
    }
    enablePositionalOptions(positional = true) {
      this._enablePositionalOptions = !!positional;
      return this;
    }
    passThroughOptions(passThrough = true) {
      this._passThroughOptions = !!passThrough;
      this._checkForBrokenPassThrough();
      return this;
    }
    _checkForBrokenPassThrough() {
      if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
        throw new Error(
          `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`,
        );
      }
    }
    storeOptionsAsProperties(storeAsProperties = true) {
      if (this.options.length) {
        throw new Error('call .storeOptionsAsProperties() before adding options');
      }
      if (Object.keys(this._optionValues).length) {
        throw new Error('call .storeOptionsAsProperties() before setting option values');
      }
      this._storeOptionsAsProperties = !!storeAsProperties;
      return this;
    }
    getOptionValue(key) {
      if (this._storeOptionsAsProperties) {
        return this[key];
      }
      return this._optionValues[key];
    }
    setOptionValue(key, value) {
      return this.setOptionValueWithSource(key, value, undefined);
    }
    setOptionValueWithSource(key, value, source) {
      if (this._storeOptionsAsProperties) {
        this[key] = value;
      } else {
        this._optionValues[key] = value;
      }
      this._optionValueSources[key] = source;
      return this;
    }
    getOptionValueSource(key) {
      return this._optionValueSources[key];
    }
    getOptionValueSourceWithGlobals(key) {
      let source;
      this._getCommandAndAncestors().forEach(cmd => {
        if (cmd.getOptionValueSource(key) !== undefined) {
          source = cmd.getOptionValueSource(key);
        }
      });
      return source;
    }
    _prepareUserArgs(argv, parseOptions) {
      if (argv !== undefined && !Array.isArray(argv)) {
        throw new Error('first parameter to parse must be array or undefined');
      }
      parseOptions = parseOptions || {};
      if (argv === undefined && parseOptions.from === undefined) {
        if (process2.versions?.electron) {
          parseOptions.from = 'electron';
        }
        const execArgv = process2.execArgv ?? [];
        if (
          execArgv.includes('-e') ||
          execArgv.includes('--eval') ||
          execArgv.includes('-p') ||
          execArgv.includes('--print')
        ) {
          parseOptions.from = 'eval';
        }
      }
      if (argv === undefined) {
        argv = process2.argv;
      }
      this.rawArgs = argv.slice();
      let userArgs;
      switch (parseOptions.from) {
        case undefined:
        case 'node':
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
          break;
        case 'electron':
          if (process2.defaultApp) {
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
          } else {
            userArgs = argv.slice(1);
          }
          break;
        case 'user':
          userArgs = argv.slice(0);
          break;
        case 'eval':
          userArgs = argv.slice(1);
          break;
        default:
          throw new Error(`unexpected parse option { from: '${parseOptions.from}' }`);
      }
      if (!this._name && this._scriptPath) this.nameFromFilename(this._scriptPath);
      this._name = this._name || 'program';
      return userArgs;
    }
    parse(argv, parseOptions) {
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      this._parseCommand([], userArgs);
      return this;
    }
    async parseAsync(argv, parseOptions) {
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      await this._parseCommand([], userArgs);
      return this;
    }
    _executeSubCommand(subcommand, args) {
      args = args.slice();
      let launchWithNode = false;
      const sourceExt = ['.js', '.ts', '.tsx', '.mjs', '.cjs'];
      function findFile(baseDir, baseName) {
        const localBin = path.resolve(baseDir, baseName);
        if (fs.existsSync(localBin)) return localBin;
        if (sourceExt.includes(path.extname(baseName))) return;
        const foundExt = sourceExt.find(ext => fs.existsSync(`${localBin}${ext}`));
        if (foundExt) return `${localBin}${foundExt}`;
        return;
      }
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
      let executableDir = this._executableDir || '';
      if (this._scriptPath) {
        let resolvedScriptPath;
        try {
          resolvedScriptPath = fs.realpathSync(this._scriptPath);
        } catch (err) {
          resolvedScriptPath = this._scriptPath;
        }
        executableDir = path.resolve(path.dirname(resolvedScriptPath), executableDir);
      }
      if (executableDir) {
        let localFile = findFile(executableDir, executableFile);
        if (!localFile && !subcommand._executableFile && this._scriptPath) {
          const legacyName = path.basename(this._scriptPath, path.extname(this._scriptPath));
          if (legacyName !== this._name) {
            localFile = findFile(executableDir, `${legacyName}-${subcommand._name}`);
          }
        }
        executableFile = localFile || executableFile;
      }
      launchWithNode = sourceExt.includes(path.extname(executableFile));
      let proc;
      if (process2.platform !== 'win32') {
        if (launchWithNode) {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.argv[0], args, { stdio: 'inherit' });
        } else {
          proc = childProcess.spawn(executableFile, args, { stdio: 'inherit' });
        }
      } else {
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.execPath, args, { stdio: 'inherit' });
      }
      if (!proc.killed) {
        const signals = ['SIGUSR1', 'SIGUSR2', 'SIGTERM', 'SIGINT', 'SIGHUP'];
        signals.forEach(signal => {
          process2.on(signal, () => {
            if (proc.killed === false && proc.exitCode === null) {
              proc.kill(signal);
            }
          });
        });
      }
      const exitCallback = this._exitCallback;
      proc.on('close', code => {
        code = code ?? 1;
        if (!exitCallback) {
          process2.exit(code);
        } else {
          exitCallback(new CommanderError(code, 'commander.executeSubCommandAsync', '(close)'));
        }
      });
      proc.on('error', err => {
        if (err.code === 'ENOENT') {
          const executableDirMessage = executableDir
            ? `searched for local subcommand relative to directory '${executableDir}'`
            : 'no directory for search for local subcommand, use .executableDir() to supply a custom directory';
          const executableMissing = `'${executableFile}' does not exist
 - if '${subcommand._name}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
          throw new Error(executableMissing);
        } else if (err.code === 'EACCES') {
          throw new Error(`'${executableFile}' not executable`);
        }
        if (!exitCallback) {
          process2.exit(1);
        } else {
          const wrappedError = new CommanderError(1, 'commander.executeSubCommandAsync', '(error)');
          wrappedError.nestedError = err;
          exitCallback(wrappedError);
        }
      });
      this.runningCommand = proc;
    }
    _dispatchSubcommand(commandName, operands, unknown) {
      const subCommand = this._findCommand(commandName);
      if (!subCommand) this.help({ error: true });
      let promiseChain;
      promiseChain = this._chainOrCallSubCommandHook(promiseChain, subCommand, 'preSubcommand');
      promiseChain = this._chainOrCall(promiseChain, () => {
        if (subCommand._executableHandler) {
          this._executeSubCommand(subCommand, operands.concat(unknown));
        } else {
          return subCommand._parseCommand(operands, unknown);
        }
      });
      return promiseChain;
    }
    _dispatchHelpCommand(subcommandName) {
      if (!subcommandName) {
        this.help();
      }
      const subCommand = this._findCommand(subcommandName);
      if (subCommand && !subCommand._executableHandler) {
        subCommand.help();
      }
      return this._dispatchSubcommand(
        subcommandName,
        [],
        [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? '--help'],
      );
    }
    _checkNumberOfArguments() {
      this.registeredArguments.forEach((arg, i) => {
        if (arg.required && this.args[i] == null) {
          this.missingArgument(arg.name());
        }
      });
      if (
        this.registeredArguments.length > 0 &&
        this.registeredArguments[this.registeredArguments.length - 1].variadic
      ) {
        return;
      }
      if (this.args.length > this.registeredArguments.length) {
        this._excessArguments(this.args);
      }
    }
    _processArguments() {
      const myParseArg = (argument, value, previous) => {
        let parsedValue = value;
        if (value !== null && argument.parseArg) {
          const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
          parsedValue = this._callParseArg(argument, value, previous, invalidValueMessage);
        }
        return parsedValue;
      };
      this._checkNumberOfArguments();
      const processedArgs = [];
      this.registeredArguments.forEach((declaredArg, index) => {
        let value = declaredArg.defaultValue;
        if (declaredArg.variadic) {
          if (index < this.args.length) {
            value = this.args.slice(index);
            if (declaredArg.parseArg) {
              value = value.reduce((processed, v) => {
                return myParseArg(declaredArg, v, processed);
              }, declaredArg.defaultValue);
            }
          } else if (value === undefined) {
            value = [];
          }
        } else if (index < this.args.length) {
          value = this.args[index];
          if (declaredArg.parseArg) {
            value = myParseArg(declaredArg, value, declaredArg.defaultValue);
          }
        }
        processedArgs[index] = value;
      });
      this.processedArgs = processedArgs;
    }
    _chainOrCall(promise, fn) {
      if (promise && promise.then && typeof promise.then === 'function') {
        return promise.then(() => fn());
      }
      return fn();
    }
    _chainOrCallHooks(promise, event) {
      let result = promise;
      const hooks = [];
      this._getCommandAndAncestors()
        .reverse()
        .filter(cmd => cmd._lifeCycleHooks[event] !== undefined)
        .forEach(hookedCommand => {
          hookedCommand._lifeCycleHooks[event].forEach(callback => {
            hooks.push({ hookedCommand, callback });
          });
        });
      if (event === 'postAction') {
        hooks.reverse();
      }
      hooks.forEach(hookDetail => {
        result = this._chainOrCall(result, () => {
          return hookDetail.callback(hookDetail.hookedCommand, this);
        });
      });
      return result;
    }
    _chainOrCallSubCommandHook(promise, subCommand, event) {
      let result = promise;
      if (this._lifeCycleHooks[event] !== undefined) {
        this._lifeCycleHooks[event].forEach(hook => {
          result = this._chainOrCall(result, () => {
            return hook(this, subCommand);
          });
        });
      }
      return result;
    }
    _parseCommand(operands, unknown) {
      const parsed = this.parseOptions(unknown);
      this._parseOptionsEnv();
      this._parseOptionsImplied();
      operands = operands.concat(parsed.operands);
      unknown = parsed.unknown;
      this.args = operands.concat(unknown);
      if (operands && this._findCommand(operands[0])) {
        return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
      }
      if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
        return this._dispatchHelpCommand(operands[1]);
      }
      if (this._defaultCommandName) {
        this._outputHelpIfRequested(unknown);
        return this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
      }
      if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
        this.help({ error: true });
      }
      this._outputHelpIfRequested(parsed.unknown);
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      const checkForUnknownOptions = () => {
        if (parsed.unknown.length > 0) {
          this.unknownOption(parsed.unknown[0]);
        }
      };
      const commandEvent = `command:${this.name()}`;
      if (this._actionHandler) {
        checkForUnknownOptions();
        this._processArguments();
        let promiseChain;
        promiseChain = this._chainOrCallHooks(promiseChain, 'preAction');
        promiseChain = this._chainOrCall(promiseChain, () => this._actionHandler(this.processedArgs));
        if (this.parent) {
          promiseChain = this._chainOrCall(promiseChain, () => {
            this.parent.emit(commandEvent, operands, unknown);
          });
        }
        promiseChain = this._chainOrCallHooks(promiseChain, 'postAction');
        return promiseChain;
      }
      if (this.parent && this.parent.listenerCount(commandEvent)) {
        checkForUnknownOptions();
        this._processArguments();
        this.parent.emit(commandEvent, operands, unknown);
      } else if (operands.length) {
        if (this._findCommand('*')) {
          return this._dispatchSubcommand('*', operands, unknown);
        }
        if (this.listenerCount('command:*')) {
          this.emit('command:*', operands, unknown);
        } else if (this.commands.length) {
          this.unknownCommand();
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      } else if (this.commands.length) {
        checkForUnknownOptions();
        this.help({ error: true });
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    }
    _findCommand(name) {
      if (!name) return;
      return this.commands.find(cmd => cmd._name === name || cmd._aliases.includes(name));
    }
    _findOption(arg) {
      return this.options.find(option => option.is(arg));
    }
    _checkForMissingMandatoryOptions() {
      this._getCommandAndAncestors().forEach(cmd => {
        cmd.options.forEach(anOption => {
          if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === undefined) {
            cmd.missingMandatoryOptionValue(anOption);
          }
        });
      });
    }
    _checkForConflictingLocalOptions() {
      const definedNonDefaultOptions = this.options.filter(option => {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === undefined) {
          return false;
        }
        return this.getOptionValueSource(optionKey) !== 'default';
      });
      const optionsWithConflicting = definedNonDefaultOptions.filter(option => option.conflictsWith.length > 0);
      optionsWithConflicting.forEach(option => {
        const conflictingAndDefined = definedNonDefaultOptions.find(defined =>
          option.conflictsWith.includes(defined.attributeName()),
        );
        if (conflictingAndDefined) {
          this._conflictingOption(option, conflictingAndDefined);
        }
      });
    }
    _checkForConflictingOptions() {
      this._getCommandAndAncestors().forEach(cmd => {
        cmd._checkForConflictingLocalOptions();
      });
    }
    parseOptions(argv) {
      const operands = [];
      const unknown = [];
      let dest = operands;
      const args = argv.slice();
      function maybeOption(arg) {
        return arg.length > 1 && arg[0] === '-';
      }
      let activeVariadicOption = null;
      while (args.length) {
        const arg = args.shift();
        if (arg === '--') {
          if (dest === unknown) dest.push(arg);
          dest.push(...args);
          break;
        }
        if (activeVariadicOption && !maybeOption(arg)) {
          this.emit(`option:${activeVariadicOption.name()}`, arg);
          continue;
        }
        activeVariadicOption = null;
        if (maybeOption(arg)) {
          const option = this._findOption(arg);
          if (option) {
            if (option.required) {
              const value = args.shift();
              if (value === undefined) this.optionMissingArgument(option);
              this.emit(`option:${option.name()}`, value);
            } else if (option.optional) {
              let value = null;
              if (args.length > 0 && !maybeOption(args[0])) {
                value = args.shift();
              }
              this.emit(`option:${option.name()}`, value);
            } else {
              this.emit(`option:${option.name()}`);
            }
            activeVariadicOption = option.variadic ? option : null;
            continue;
          }
        }
        if (arg.length > 2 && arg[0] === '-' && arg[1] !== '-') {
          const option = this._findOption(`-${arg[1]}`);
          if (option) {
            if (option.required || (option.optional && this._combineFlagAndOptionalValue)) {
              this.emit(`option:${option.name()}`, arg.slice(2));
            } else {
              this.emit(`option:${option.name()}`);
              args.unshift(`-${arg.slice(2)}`);
            }
            continue;
          }
        }
        if (/^--[^=]+=/.test(arg)) {
          const index = arg.indexOf('=');
          const option = this._findOption(arg.slice(0, index));
          if (option && (option.required || option.optional)) {
            this.emit(`option:${option.name()}`, arg.slice(index + 1));
            continue;
          }
        }
        if (maybeOption(arg)) {
          dest = unknown;
        }
        if (
          (this._enablePositionalOptions || this._passThroughOptions) &&
          operands.length === 0 &&
          unknown.length === 0
        ) {
          if (this._findCommand(arg)) {
            operands.push(arg);
            if (args.length > 0) unknown.push(...args);
            break;
          } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
            operands.push(arg);
            if (args.length > 0) operands.push(...args);
            break;
          } else if (this._defaultCommandName) {
            unknown.push(arg);
            if (args.length > 0) unknown.push(...args);
            break;
          }
        }
        if (this._passThroughOptions) {
          dest.push(arg);
          if (args.length > 0) dest.push(...args);
          break;
        }
        dest.push(arg);
      }
      return { operands, unknown };
    }
    opts() {
      if (this._storeOptionsAsProperties) {
        const result = {};
        const len = this.options.length;
        for (let i = 0; i < len; i++) {
          const key = this.options[i].attributeName();
          result[key] = key === this._versionOptionName ? this._version : this[key];
        }
        return result;
      }
      return this._optionValues;
    }
    optsWithGlobals() {
      return this._getCommandAndAncestors().reduce(
        (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
        {},
      );
    }
    error(message, errorOptions) {
      this._outputConfiguration.outputError(
        `${message}
`,
        this._outputConfiguration.writeErr,
      );
      if (typeof this._showHelpAfterError === 'string') {
        this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
      } else if (this._showHelpAfterError) {
        this._outputConfiguration.writeErr(`
`);
        this.outputHelp({ error: true });
      }
      const config = errorOptions || {};
      const exitCode = config.exitCode || 1;
      const code = config.code || 'commander.error';
      this._exit(exitCode, code, message);
    }
    _parseOptionsEnv() {
      this.options.forEach(option => {
        if (option.envVar && option.envVar in process2.env) {
          const optionKey = option.attributeName();
          if (
            this.getOptionValue(optionKey) === undefined ||
            ['default', 'config', 'env'].includes(this.getOptionValueSource(optionKey))
          ) {
            if (option.required || option.optional) {
              this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
            } else {
              this.emit(`optionEnv:${option.name()}`);
            }
          }
        }
      });
    }
    _parseOptionsImplied() {
      const dualHelper = new DualOptions(this.options);
      const hasCustomOptionValue = optionKey => {
        return (
          this.getOptionValue(optionKey) !== undefined &&
          !['default', 'implied'].includes(this.getOptionValueSource(optionKey))
        );
      };
      this.options
        .filter(
          option =>
            option.implied !== undefined &&
            hasCustomOptionValue(option.attributeName()) &&
            dualHelper.valueFromOption(this.getOptionValue(option.attributeName()), option),
        )
        .forEach(option => {
          Object.keys(option.implied)
            .filter(impliedKey => !hasCustomOptionValue(impliedKey))
            .forEach(impliedKey => {
              this.setOptionValueWithSource(impliedKey, option.implied[impliedKey], 'implied');
            });
        });
    }
    missingArgument(name) {
      const message = `error: missing required argument '${name}'`;
      this.error(message, { code: 'commander.missingArgument' });
    }
    optionMissingArgument(option) {
      const message = `error: option '${option.flags}' argument missing`;
      this.error(message, { code: 'commander.optionMissingArgument' });
    }
    missingMandatoryOptionValue(option) {
      const message = `error: required option '${option.flags}' not specified`;
      this.error(message, { code: 'commander.missingMandatoryOptionValue' });
    }
    _conflictingOption(option, conflictingOption) {
      const findBestOptionFromValue = option2 => {
        const optionKey = option2.attributeName();
        const optionValue = this.getOptionValue(optionKey);
        const negativeOption = this.options.find(target => target.negate && optionKey === target.attributeName());
        const positiveOption = this.options.find(target => !target.negate && optionKey === target.attributeName());
        if (
          negativeOption &&
          ((negativeOption.presetArg === undefined && optionValue === false) ||
            (negativeOption.presetArg !== undefined && optionValue === negativeOption.presetArg))
        ) {
          return negativeOption;
        }
        return positiveOption || option2;
      };
      const getErrorMessage = option2 => {
        const bestOption = findBestOptionFromValue(option2);
        const optionKey = bestOption.attributeName();
        const source = this.getOptionValueSource(optionKey);
        if (source === 'env') {
          return `environment variable '${bestOption.envVar}'`;
        }
        return `option '${bestOption.flags}'`;
      };
      const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
      this.error(message, { code: 'commander.conflictingOption' });
    }
    unknownOption(flag) {
      if (this._allowUnknownOption) return;
      let suggestion = '';
      if (flag.startsWith('--') && this._showSuggestionAfterError) {
        let candidateFlags = [];
        let command = this;
        do {
          const moreFlags = command
            .createHelp()
            .visibleOptions(command)
            .filter(option => option.long)
            .map(option => option.long);
          candidateFlags = candidateFlags.concat(moreFlags);
          command = command.parent;
        } while (command && !command._enablePositionalOptions);
        suggestion = suggestSimilar(flag, candidateFlags);
      }
      const message = `error: unknown option '${flag}'${suggestion}`;
      this.error(message, { code: 'commander.unknownOption' });
    }
    _excessArguments(receivedArgs) {
      if (this._allowExcessArguments) return;
      const expected = this.registeredArguments.length;
      const s = expected === 1 ? '' : 's';
      const forSubcommand = this.parent ? ` for '${this.name()}'` : '';
      const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
      this.error(message, { code: 'commander.excessArguments' });
    }
    unknownCommand() {
      const unknownName = this.args[0];
      let suggestion = '';
      if (this._showSuggestionAfterError) {
        const candidateNames = [];
        this.createHelp()
          .visibleCommands(this)
          .forEach(command => {
            candidateNames.push(command.name());
            if (command.alias()) candidateNames.push(command.alias());
          });
        suggestion = suggestSimilar(unknownName, candidateNames);
      }
      const message = `error: unknown command '${unknownName}'${suggestion}`;
      this.error(message, { code: 'commander.unknownCommand' });
    }
    version(str, flags, description) {
      if (str === undefined) return this._version;
      this._version = str;
      flags = flags || '-V, --version';
      description = description || 'output the version number';
      const versionOption = this.createOption(flags, description);
      this._versionOptionName = versionOption.attributeName();
      this._registerOption(versionOption);
      this.on('option:' + versionOption.name(), () => {
        this._outputConfiguration.writeOut(`${str}
`);
        this._exit(0, 'commander.version', str);
      });
      return this;
    }
    description(str, argsDescription) {
      if (str === undefined && argsDescription === undefined) return this._description;
      this._description = str;
      if (argsDescription) {
        this._argsDescription = argsDescription;
      }
      return this;
    }
    summary(str) {
      if (str === undefined) return this._summary;
      this._summary = str;
      return this;
    }
    alias(alias) {
      if (alias === undefined) return this._aliases[0];
      let command = this;
      if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
        command = this.commands[this.commands.length - 1];
      }
      if (alias === command._name) throw new Error("Command alias can't be the same as its name");
      const matchingCommand = this.parent?._findCommand(alias);
      if (matchingCommand) {
        const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join('|');
        throw new Error(
          `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`,
        );
      }
      command._aliases.push(alias);
      return this;
    }
    aliases(aliases) {
      if (aliases === undefined) return this._aliases;
      aliases.forEach(alias => this.alias(alias));
      return this;
    }
    usage(str) {
      if (str === undefined) {
        if (this._usage) return this._usage;
        const args = this.registeredArguments.map(arg => {
          return humanReadableArgName(arg);
        });
        return []
          .concat(
            this.options.length || this._helpOption !== null ? '[options]' : [],
            this.commands.length ? '[command]' : [],
            this.registeredArguments.length ? args : [],
          )
          .join(' ');
      }
      this._usage = str;
      return this;
    }
    name(str) {
      if (str === undefined) return this._name;
      this._name = str;
      return this;
    }
    nameFromFilename(filename) {
      this._name = path.basename(filename, path.extname(filename));
      return this;
    }
    executableDir(path2) {
      if (path2 === undefined) return this._executableDir;
      this._executableDir = path2;
      return this;
    }
    helpInformation(contextOptions) {
      const helper = this.createHelp();
      if (helper.helpWidth === undefined) {
        helper.helpWidth =
          contextOptions && contextOptions.error
            ? this._outputConfiguration.getErrHelpWidth()
            : this._outputConfiguration.getOutHelpWidth();
      }
      return helper.formatHelp(this, helper);
    }
    _getHelpContext(contextOptions) {
      contextOptions = contextOptions || {};
      const context = { error: !!contextOptions.error };
      let write;
      if (context.error) {
        write = arg => this._outputConfiguration.writeErr(arg);
      } else {
        write = arg => this._outputConfiguration.writeOut(arg);
      }
      context.write = contextOptions.write || write;
      context.command = this;
      return context;
    }
    outputHelp(contextOptions) {
      let deprecatedCallback;
      if (typeof contextOptions === 'function') {
        deprecatedCallback = contextOptions;
        contextOptions = undefined;
      }
      const context = this._getHelpContext(contextOptions);
      this._getCommandAndAncestors()
        .reverse()
        .forEach(command => command.emit('beforeAllHelp', context));
      this.emit('beforeHelp', context);
      let helpInformation = this.helpInformation(context);
      if (deprecatedCallback) {
        helpInformation = deprecatedCallback(helpInformation);
        if (typeof helpInformation !== 'string' && !Buffer.isBuffer(helpInformation)) {
          throw new Error('outputHelp callback must return a string or a Buffer');
        }
      }
      context.write(helpInformation);
      if (this._getHelpOption()?.long) {
        this.emit(this._getHelpOption().long);
      }
      this.emit('afterHelp', context);
      this._getCommandAndAncestors().forEach(command => command.emit('afterAllHelp', context));
    }
    helpOption(flags, description) {
      if (typeof flags === 'boolean') {
        if (flags) {
          this._helpOption = this._helpOption ?? undefined;
        } else {
          this._helpOption = null;
        }
        return this;
      }
      flags = flags ?? '-h, --help';
      description = description ?? 'display help for command';
      this._helpOption = this.createOption(flags, description);
      return this;
    }
    _getHelpOption() {
      if (this._helpOption === undefined) {
        this.helpOption(undefined, undefined);
      }
      return this._helpOption;
    }
    addHelpOption(option) {
      this._helpOption = option;
      return this;
    }
    help(contextOptions) {
      this.outputHelp(contextOptions);
      let exitCode = process2.exitCode || 0;
      if (exitCode === 0 && contextOptions && typeof contextOptions !== 'function' && contextOptions.error) {
        exitCode = 1;
      }
      this._exit(exitCode, 'commander.help', '(outputHelp)');
    }
    addHelpText(position, text) {
      const allowedValues = ['beforeAll', 'before', 'after', 'afterAll'];
      if (!allowedValues.includes(position)) {
        throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      const helpEvent = `${position}Help`;
      this.on(helpEvent, context => {
        let helpStr;
        if (typeof text === 'function') {
          helpStr = text({ error: context.error, command: context.command });
        } else {
          helpStr = text;
        }
        if (helpStr) {
          context.write(`${helpStr}
`);
        }
      });
      return this;
    }
    _outputHelpIfRequested(args) {
      const helpOption = this._getHelpOption();
      const helpRequested = helpOption && args.find(arg => helpOption.is(arg));
      if (helpRequested) {
        this.outputHelp();
        this._exit(0, 'commander.helpDisplayed', '(outputHelp)');
      }
    }
  }
  function incrementNodeInspectorPort(args) {
    return args.map(arg => {
      if (!arg.startsWith('--inspect')) {
        return arg;
      }
      let debugOption;
      let debugHost = '127.0.0.1';
      let debugPort = '9229';
      let match;
      if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
        debugOption = match[1];
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
        debugOption = match[1];
        if (/^\d+$/.test(match[3])) {
          debugPort = match[3];
        } else {
          debugHost = match[3];
        }
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
        debugOption = match[1];
        debugHost = match[3];
        debugPort = match[4];
      }
      if (debugOption && debugPort !== '0') {
        return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
      }
      return arg;
    });
  }
  exports.Command = Command;
});

// node_modules/commander/index.js
var require_commander = __commonJS(exports => {
  var { Argument } = require_argument();
  var { Command } = require_command();
  var { CommanderError, InvalidArgumentError } = require_error();
  var { Help } = require_help();
  var { Option } = require_option();
  exports.program = new Command();
  exports.createCommand = name => new Command(name);
  exports.createOption = (flags, description) => new Option(flags, description);
  exports.createArgument = (name, description) => new Argument(name, description);
  exports.Command = Command;
  exports.Option = Option;
  exports.Argument = Argument;
  exports.Help = Help;
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
  exports.InvalidOptionArgumentError = InvalidArgumentError;
});

// node_modules/picocolors/picocolors.js
var require_picocolors = __commonJS((exports, module) => {
  var p = process || {};
  var argv = p.argv || [];
  var env = p.env || {};
  var isColorSupported =
    !(!!env.NO_COLOR || argv.includes('--no-color')) &&
    (!!env.FORCE_COLOR ||
      argv.includes('--color') ||
      p.platform === 'win32' ||
      ((p.stdout || {}).isTTY && env.TERM !== 'dumb') ||
      !!env.CI);
  var formatter =
    (open, close, replace = open) =>
    input => {
      let string = '' + input,
        index = string.indexOf(close, open.length);
      return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close;
    };
  var replaceClose = (string, close, replace, index) => {
    let result = '',
      cursor = 0;
    do {
      result += string.substring(cursor, index) + replace;
      cursor = index + close.length;
      index = string.indexOf(close, cursor);
    } while (~index);
    return result + string.substring(cursor);
  };
  var createColors = (enabled = isColorSupported) => {
    let f = enabled ? formatter : () => String;
    return {
      isColorSupported: enabled,
      reset: f('\x1B[0m', '\x1B[0m'),
      bold: f('\x1B[1m', '\x1B[22m', '\x1B[22m\x1B[1m'),
      dim: f('\x1B[2m', '\x1B[22m', '\x1B[22m\x1B[2m'),
      italic: f('\x1B[3m', '\x1B[23m'),
      underline: f('\x1B[4m', '\x1B[24m'),
      inverse: f('\x1B[7m', '\x1B[27m'),
      hidden: f('\x1B[8m', '\x1B[28m'),
      strikethrough: f('\x1B[9m', '\x1B[29m'),
      black: f('\x1B[30m', '\x1B[39m'),
      red: f('\x1B[31m', '\x1B[39m'),
      green: f('\x1B[32m', '\x1B[39m'),
      yellow: f('\x1B[33m', '\x1B[39m'),
      blue: f('\x1B[34m', '\x1B[39m'),
      magenta: f('\x1B[35m', '\x1B[39m'),
      cyan: f('\x1B[36m', '\x1B[39m'),
      white: f('\x1B[37m', '\x1B[39m'),
      gray: f('\x1B[90m', '\x1B[39m'),
      bgBlack: f('\x1B[40m', '\x1B[49m'),
      bgRed: f('\x1B[41m', '\x1B[49m'),
      bgGreen: f('\x1B[42m', '\x1B[49m'),
      bgYellow: f('\x1B[43m', '\x1B[49m'),
      bgBlue: f('\x1B[44m', '\x1B[49m'),
      bgMagenta: f('\x1B[45m', '\x1B[49m'),
      bgCyan: f('\x1B[46m', '\x1B[49m'),
      bgWhite: f('\x1B[47m', '\x1B[49m'),
      blackBright: f('\x1B[90m', '\x1B[39m'),
      redBright: f('\x1B[91m', '\x1B[39m'),
      greenBright: f('\x1B[92m', '\x1B[39m'),
      yellowBright: f('\x1B[93m', '\x1B[39m'),
      blueBright: f('\x1B[94m', '\x1B[39m'),
      magentaBright: f('\x1B[95m', '\x1B[39m'),
      cyanBright: f('\x1B[96m', '\x1B[39m'),
      whiteBright: f('\x1B[97m', '\x1B[39m'),
      bgBlackBright: f('\x1B[100m', '\x1B[49m'),
      bgRedBright: f('\x1B[101m', '\x1B[49m'),
      bgGreenBright: f('\x1B[102m', '\x1B[49m'),
      bgYellowBright: f('\x1B[103m', '\x1B[49m'),
      bgBlueBright: f('\x1B[104m', '\x1B[49m'),
      bgMagentaBright: f('\x1B[105m', '\x1B[49m'),
      bgCyanBright: f('\x1B[106m', '\x1B[49m'),
      bgWhiteBright: f('\x1B[107m', '\x1B[49m'),
    };
  };
  module.exports = createColors();
  module.exports.createColors = createColors;
});

// node_modules/nanoid/url-alphabet/index.js
var urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

// node_modules/nanoid/index.js
var exports_nanoid = {};
__export(exports_nanoid, {
  urlAlphabet: () => urlAlphabet,
  random: () => random,
  nanoid: () => nanoid,
  customRandom: () => customRandom,
  customAlphabet: () => customAlphabet,
});
import { webcrypto as crypto2 } from 'crypto';
function fillPool(bytes) {
  if (!pool || pool.length < bytes) {
    pool = Buffer.allocUnsafe(bytes * POOL_SIZE_MULTIPLIER);
    crypto2.getRandomValues(pool);
    poolOffset = 0;
  } else if (poolOffset + bytes > pool.length) {
    crypto2.getRandomValues(pool);
    poolOffset = 0;
  }
  poolOffset += bytes;
}
function random(bytes) {
  fillPool((bytes |= 0));
  return pool.subarray(poolOffset - bytes, poolOffset);
}
function customRandom(alphabet, defaultSize, getRandom) {
  let mask = (2 << (31 - Math.clz32((alphabet.length - 1) | 1))) - 1;
  let step = Math.ceil((1.6 * mask * defaultSize) / alphabet.length);
  return (size = defaultSize) => {
    if (!size) return '';
    let id = '';
    while (true) {
      let bytes = getRandom(step);
      let i = step;
      while (i--) {
        id += alphabet[bytes[i] & mask] || '';
        if (id.length >= size) return id;
      }
    }
  };
}
function customAlphabet(alphabet, size = 21) {
  return customRandom(alphabet, size, random);
}
function nanoid(size = 21) {
  fillPool((size |= 0));
  let id = '';
  for (let i = poolOffset - size; i < poolOffset; i++) {
    id += urlAlphabet[pool[i] & 63];
  }
  return id;
}
var POOL_SIZE_MULTIPLIER = 128,
  pool,
  poolOffset;
var init_nanoid = () => {};

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS(exports => {
  var ALIAS = Symbol.for('yaml.alias');
  var DOC = Symbol.for('yaml.document');
  var MAP = Symbol.for('yaml.map');
  var PAIR = Symbol.for('yaml.pair');
  var SCALAR = Symbol.for('yaml.scalar');
  var SEQ = Symbol.for('yaml.seq');
  var NODE_TYPE = Symbol.for('yaml.node.type');
  var isAlias = node => !!node && typeof node === 'object' && node[NODE_TYPE] === ALIAS;
  var isDocument = node => !!node && typeof node === 'object' && node[NODE_TYPE] === DOC;
  var isMap = node => !!node && typeof node === 'object' && node[NODE_TYPE] === MAP;
  var isPair = node => !!node && typeof node === 'object' && node[NODE_TYPE] === PAIR;
  var isScalar = node => !!node && typeof node === 'object' && node[NODE_TYPE] === SCALAR;
  var isSeq = node => !!node && typeof node === 'object' && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === 'object')
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === 'object')
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = node => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS(exports => {
  var identity = require_identity();
  var BREAK = Symbol('break visit');
  var SKIP = Symbol('skip children');
  var REMOVE = Symbol('remove node');
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE) node.contents = null;
    } else visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path5) {
    const ctrl = callVisitor(key, node, visitor, path5);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path5, ctrl);
      return visit_(key, ctrl, visitor, path5);
    }
    if (typeof ctrl !== 'symbol') {
      if (identity.isCollection(node)) {
        path5 = Object.freeze(path5.concat(node));
        for (let i = 0; i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path5);
          if (typeof ci === 'number') i = ci - 1;
          else if (ci === BREAK) return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path5 = Object.freeze(path5.concat(node));
        const ck = visit_('key', node.key, visitor, path5);
        if (ck === BREAK) return BREAK;
        else if (ck === REMOVE) node.key = null;
        const cv = visit_('value', node.value, visitor, path5);
        if (cv === BREAK) return BREAK;
        else if (cv === REMOVE) node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE) node.contents = null;
    } else await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path5) {
    const ctrl = await callVisitor(key, node, visitor, path5);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path5, ctrl);
      return visitAsync_(key, ctrl, visitor, path5);
    }
    if (typeof ctrl !== 'symbol') {
      if (identity.isCollection(node)) {
        path5 = Object.freeze(path5.concat(node));
        for (let i = 0; i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path5);
          if (typeof ci === 'number') i = ci - 1;
          else if (ci === BREAK) return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path5 = Object.freeze(path5.concat(node));
        const ck = await visitAsync_('key', node.key, visitor, path5);
        if (ck === BREAK) return BREAK;
        else if (ck === REMOVE) node.key = null;
        const cv = await visitAsync_('value', node.value, visitor, path5);
        if (cv === BREAK) return BREAK;
        else if (cv === REMOVE) node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === 'object' && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign(
        {
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node,
        },
        visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value,
        },
        visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection,
        },
        visitor,
      );
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path5) {
    if (typeof visitor === 'function') return visitor(key, node, path5);
    if (identity.isMap(node)) return visitor.Map?.(key, node, path5);
    if (identity.isSeq(node)) return visitor.Seq?.(key, node, path5);
    if (identity.isPair(node)) return visitor.Pair?.(key, node, path5);
    if (identity.isScalar(node)) return visitor.Scalar?.(key, node, path5);
    if (identity.isAlias(node)) return visitor.Alias?.(key, node, path5);
    return;
  }
  function replaceNode(key, path5, node) {
    const parent = path5[path5.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === 'key') parent.key = node;
      else parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? 'alias' : 'scalar';
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS(exports => {
  var identity = require_identity();
  var visit = require_visit();
  var escapeChars = {
    '!': '%21',
    ',': '%2C',
    '[': '%5B',
    ']': '%5D',
    '{': '%7B',
    '}': '%7D',
  };
  var escapeTagName = tn => tn.replace(/[!,[\]{}]/g, ch => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case '1.1':
          this.atNextDocument = true;
          break;
        case '1.2':
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: '1.2',
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: '1.1' };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case '%TAG': {
          if (parts.length !== 2) {
            onError(0, '%TAG directive should contain exactly two parts');
            if (parts.length < 2) return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case '%YAML': {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, '%YAML directive should contain exactly one part');
            return false;
          }
          const [version] = parts;
          if (version === '1.1' || version === '1.2') {
            this.yaml.version = version;
            return true;
          } else {
            const isValid3 = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid3);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === '!') return '!';
      if (source[0] !== '!') {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === '<') {
        const verbatim = source.slice(2, -1);
        if (verbatim === '!' || verbatim === '!!') {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== '>') onError('Verbatim tags must end with a >');
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix) onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === '!') return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix)) return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === '!' ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || '1.2'}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag) tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === '!!' && prefix === 'tag:yaml.org,2002:') continue;
        if (!doc || tagNames.some(tn => tn.startsWith(prefix))) lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: '1.2' };
  Directives.defaultTags = { '!!': 'tag:yaml.org,2002:' };
  exports.Directives = Directives;
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS(exports => {
  var identity = require_identity();
  var visit = require_visit();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set();
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor) anchors.add(node.anchor);
      },
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1; ; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name)) return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map();
    let prevAnchors = null;
    return {
      onAnchor: source => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (
            typeof ref === 'object' &&
            ref.anchor &&
            (identity.isScalar(ref.node) || identity.isCollection(ref.node))
          ) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error('Failed to resolve repeated object (this should not happen)');
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects,
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS(exports => {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length; i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined) delete val[i];
          else if (v1 !== v0) val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k of Array.from(val.keys())) {
          const v0 = val.get(k);
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined) val.delete(k);
          else if (v1 !== v0) val.set(k, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined) val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined) delete val[k];
          else if (v1 !== v0) val[k] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS(exports => {
  var identity = require_identity();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value)) return value.map((v, i) => toJS(v, String(i), ctx));
    if (value && typeof value.toJSON === 'function') {
      if (!ctx || !identity.hasAnchor(value)) return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = res2 => {
        data.res = res2;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate) ctx.onCreate(res);
      return res;
    }
    if (typeof value === 'bigint' && !ctx?.keep) return Number(value);
    return value;
  }
  exports.toJS = toJS;
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS(exports => {
  var applyReviver = require_applyReviver();
  var identity = require_identity();
  var toJS = require_toJS();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range) copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc)) throw new TypeError('A document argument is required');
      const ctx = {
        anchors: new Map(),
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === 'number' ? maxAliasCount : 100,
      };
      const res = toJS.toJS(this, '', ctx);
      if (typeof onAnchor === 'function')
        for (const { count, res: res2 } of ctx.anchors.values()) onAnchor(res2, count);
      return typeof reviver === 'function' ? applyReviver.applyReviver(reviver, { '': res }, '', res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS(exports => {
  var anchors = require_anchors();
  var visit = require_visit();
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, 'tag', {
        set() {
          throw new Error('Alias nodes cannot have tags');
        },
      });
    }
    resolve(doc, ctx) {
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node)) nodes.push(node);
          },
        });
        if (ctx) ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this) break;
        if (node.anchor === this.source) found = node;
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx) return { source: this.source };
      const { anchors: anchors2, doc, maxAliasCount } = ctx;
      const source = this.resolve(doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      let data = anchors2.get(source);
      if (!data) {
        toJS.toJS(source, null, ctx);
        data = anchors2.get(source);
      }
      if (data?.res === undefined) {
        const msg = 'This should not happen: Alias anchor was not resolved?';
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0) data.aliasCount = getAliasCount(doc, source, anchors2);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = 'Excessive alias count indicates a resource exhaustion attack';
          throw new ReferenceError(msg);
        }
      }
      return data.res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey) return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors2) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors2 && source && anchors2.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors2);
        if (c > count) count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors2);
      const vc = getAliasCount(doc, node.value, anchors2);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS(exports => {
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();
  var isScalarValue = value => !value || (typeof value !== 'function' && typeof value !== 'object');

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = 'BLOCK_FOLDED';
  Scalar.BLOCK_LITERAL = 'BLOCK_LITERAL';
  Scalar.PLAIN = 'PLAIN';
  Scalar.QUOTE_DOUBLE = 'QUOTE_DOUBLE';
  Scalar.QUOTE_SINGLE = 'QUOTE_SINGLE';
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS(exports => {
  var Alias = require_Alias();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var defaultTagPrefix = 'tag:yaml.org,2002:';
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match2 = tags.filter(t => t.tag === tagName);
      const tagObj = match2.find(t => !t.format) ?? match2[0];
      if (!tagObj) throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find(t => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value)) value = value.contents;
    if (identity.isNode(value)) return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (
      value instanceof String ||
      value instanceof Number ||
      value instanceof Boolean ||
      (typeof BigInt !== 'undefined' && value instanceof BigInt)
    ) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === 'object') {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith('!!')) tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === 'function') {
        value = value.toJSON();
      }
      if (!value || typeof value !== 'object') {
        const node2 = new Scalar.Scalar(value);
        if (ref) ref.node = node2;
        return node2;
      }
      tagObj =
        value instanceof Map
          ? schema[identity.MAP]
          : Symbol.iterator in Object(value)
            ? schema[identity.SEQ]
            : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode
      ? tagObj.createNode(ctx.schema, value, ctx)
      : typeof tagObj?.nodeClass?.from === 'function'
        ? tagObj.nodeClass.from(ctx.schema, value, ctx)
        : new Scalar.Scalar(value);
    if (tagName) node.tag = tagName;
    else if (!tagObj.default) node.tag = tagObj.tag;
    if (ref) ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS(exports => {
  var createNode = require_createNode();
  var identity = require_identity();
  var Node = require_Node();
  function collectionFromPath(schema, path5, value) {
    let v = value;
    for (let i = path5.length - 1; i >= 0; --i) {
      const k = path5[i];
      if (typeof k === 'number' && Number.isInteger(k) && k >= 0) {
        const a = [];
        a[k] = v;
        v = a;
      } else {
        v = new Map([[k, v]]);
      }
    }
    return createNode.createNode(v, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error('This should not happen, please report a bug.');
      },
      schema,
      sourceObjects: new Map(),
    });
  }
  var isEmptyPath = path5 => path5 == null || (typeof path5 === 'object' && !!path5[Symbol.iterator]().next().done);

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, 'schema', {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema) copy.schema = schema;
      copy.items = copy.items.map(it => (identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it));
      if (this.range) copy.range = this.range.slice();
      return copy;
    }
    addIn(path5, value) {
      if (isEmptyPath(path5)) this.add(value);
      else {
        const [key, ...rest] = path5;
        const node = this.get(key, true);
        if (identity.isCollection(node)) node.addIn(rest, value);
        else if (node === undefined && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
        else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path5) {
      const [key, ...rest] = path5;
      if (rest.length === 0) return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node)) return node.deleteIn(rest);
      else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path5, keepScalar) {
      const [key, ...rest] = path5;
      const node = this.get(key, true);
      if (rest.length === 0) return !keepScalar && identity.isScalar(node) ? node.value : node;
      else return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every(node => {
        if (!identity.isPair(node)) return false;
        const n = node.value;
        return (
          n == null ||
          (allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag)
        );
      });
    }
    hasIn(path5) {
      const [key, ...rest] = path5;
      if (rest.length === 0) return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path5, value) {
      const [key, ...rest] = path5;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node)) node.setIn(rest, value);
        else if (node === undefined && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
        else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS(exports => {
  var stringifyComment = str => str.replace(/^(?!$)(?: $)?/gm, '#');
  function indentComment(comment, indent2) {
    if (/^\n+$/.test(comment)) return comment.substring(1);
    return indent2 ? comment.replace(/^(?! *$)/gm, indent2) : comment;
  }
  var lineComment = (str, indent2, comment) =>
    str.endsWith(`
`)
      ? indentComment(comment, indent2)
      : comment.includes(`
`)
        ? `
` + indentComment(comment, indent2)
        : (str.endsWith(' ') ? '' : ' ') + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS(exports => {
  var FOLD_FLOW = 'flow';
  var FOLD_BLOCK = 'block';
  var FOLD_QUOTED = 'quoted';
  function foldFlowLines(
    text,
    indent2,
    mode = 'flow',
    { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {},
  ) {
    if (!lineWidth || lineWidth < 0) return text;
    if (lineWidth < minContentWidth) minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent2.length);
    if (text.length <= endStep) return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent2.length;
    if (typeof indentAtStart === 'number') {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth)) folds.push(0);
      else end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent2.length);
      if (i !== -1) end = i + endStep;
    }
    for (let ch; (ch = text[(i += 1)]); ) {
      if (mode === FOLD_QUOTED && ch === '\\') {
        escStart = i;
        switch (text[i + 1]) {
          case 'x':
            i += 3;
            break;
          case 'u':
            i += 5;
            break;
          case 'U':
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (
        ch ===
        `
`
      ) {
        if (mode === FOLD_BLOCK) i = consumeMoreIndentedLines(text, i, indent2.length);
        end = i + indent2.length + endStep;
        split = undefined;
      } else {
        if (
          ch === ' ' &&
          prev &&
          prev !== ' ' &&
          prev !==
            `
` &&
          prev !== '\t'
        ) {
          const next = text[i + 1];
          if (
            next &&
            next !== ' ' &&
            next !==
              `
` &&
            next !== '\t'
          )
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === ' ' || prev === '\t') {
              prev = ch;
              ch = text[(i += 1)];
              overflow = true;
            }
            const j = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j]) return text;
            folds.push(j);
            escapedFolds[j] = true;
            end = j + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow) onOverflow();
    if (folds.length === 0) return text;
    if (onFold) onFold();
    let res = text.slice(0, folds[0]);
    for (let i2 = 0; i2 < folds.length; ++i2) {
      const fold = folds[i2];
      const end2 = folds[i2 + 1] || text.length;
      if (fold === 0)
        res = `
${indent2}${text.slice(0, end2)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold]) res += `${text[fold]}\\`;
        res += `
${indent2}${text.slice(fold + 1, end2)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent2) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === ' ' || ch === '\t') {
      if (i < start + indent2) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (
          ch &&
          ch !==
            `
`
        );
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS(exports => {
  var Scalar = require_Scalar();
  var foldFlowLines = require_foldFlowLines();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth,
  });
  var containsDocumentMarker = str => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0) return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit) return false;
    for (let i = 0, start = 0; i < strLen; ++i) {
      if (
        str[i] ===
        `
`
      ) {
        if (i - start > limit) return true;
        start = i + 1;
        if (strLen - start <= limit) return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON) return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent2 = ctx.indent || (containsDocumentMarker(value) ? '  ' : '');
    let str = '';
    let start = 0;
    for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
      if (ch === ' ' && json[i + 1] === '\\' && json[i + 2] === 'n') {
        str += json.slice(start, i) + '\\ ';
        i += 1;
        start = i;
        ch = '\\';
      }
      if (ch === '\\')
        switch (json[i + 1]) {
          case 'u':
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case '0000':
                  str += '\\0';
                  break;
                case '0007':
                  str += '\\a';
                  break;
                case '000b':
                  str += '\\v';
                  break;
                case '001b':
                  str += '\\e';
                  break;
                case '0085':
                  str += '\\N';
                  break;
                case '00a0':
                  str += '\\_';
                  break;
                case '2028':
                  str += '\\L';
                  break;
                case '2029':
                  str += '\\P';
                  break;
                default:
                  if (code.substr(0, 2) === '00') str += '\\x' + code.substr(2);
                  else str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case 'n':
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str +=
                json.slice(start, i) +
                `

`;
              while (json[i + 2] === '\\' && json[i + 3] === 'n' && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent2;
              if (json[i + 2] === ' ') str += '\\';
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey
      ? str
      : foldFlowLines.foldFlowLines(str, indent2, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (
      ctx.options.singleQuote === false ||
      (ctx.implicitKey &&
        value.includes(`
`)) ||
      /[ \t]\n|\n[ \t]/.test(value)
    )
      return doubleQuotedString(value, ctx);
    const indent2 = ctx.indent || (containsDocumentMarker(value) ? '  ' : '');
    const res =
      "'" +
      value.replace(/'/g, "''").replace(
        /\n+/g,
        `$&
${indent2}`,
      ) +
      "'";
    return ctx.implicitKey
      ? res
      : foldFlowLines.foldFlowLines(res, indent2, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false) qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle) qs = singleQuotedString;
      else if (hasSingle && !hasDouble) qs = doubleQuotedString;
      else qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(
      `(^|(?<!
))
+(?!
|$)`,
      'g',
    );
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent2 = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? '  ' : '');
    const literal =
      blockQuote === 'literal'
        ? true
        : blockQuote === 'folded' || type === Scalar.Scalar.BLOCK_FOLDED
          ? false
          : type === Scalar.Scalar.BLOCK_LITERAL
            ? true
            : !lineLengthOverLimit(value, lineWidth, indent2.length);
    if (!value)
      return literal
        ? `|
`
        : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length; endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (
        ch !==
          `
` &&
        ch !== '\t' &&
        ch !== ' '
      )
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = '-';
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = '+';
      if (onChompKeep) onChompKeep();
    } else {
      chomp = '';
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (
        end[end.length - 1] ===
        `
`
      )
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent2}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0; startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === ' ') startWithSpace = true;
      else if (
        ch ===
        `
`
      )
        startNlPos = startEnd;
      else break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent2}`);
    }
    const indentSize = indent2 ? '2' : '1';
    let header = (startWithSpace ? indentSize : '') + chomp;
    if (comment) {
      header += ' ' + commentString(comment.replace(/ ?[\r\n]+/g, ' '));
      if (onComment) onComment();
    }
    if (!literal) {
      const foldedValue = value
        .replace(
          /\n+/g,
          `
$&`,
        )
        .replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, '$1$2')
        .replace(/\n+/g, `$&${indent2}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== 'folded' && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(
        `${start}${foldedValue}${end}`,
        indent2,
        foldFlowLines.FOLD_BLOCK,
        foldOptions,
      );
      if (!literalFallback)
        return `>${header}
${indent2}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent2}`);
    return `|${header}
${indent2}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent: indent2, indentStep, inFlow } = ctx;
    if (
      (implicitKey &&
        value.includes(`
`)) ||
      (inFlow && /[[\]{},]/.test(value))
    ) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey ||
        inFlow ||
        !value.includes(`
`)
        ? quotedString(value, ctx)
        : blockString(item, ctx, onComment, onChompKeep);
    }
    if (
      !implicitKey &&
      !inFlow &&
      type !== Scalar.Scalar.PLAIN &&
      value.includes(`
`)
    ) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent2 === '') {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent2 === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(
      /\n+/g,
      `$&
${indent2}`,
    );
    if (actualString) {
      const test = tag => tag.default && tag.tag !== 'tag:yaml.org,2002:str' && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test)) return quotedString(value, ctx);
    }
    return implicitKey
      ? str
      : foldFlowLines.foldFlowLines(str, indent2, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === 'string' ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value)) type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = _type => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = (implicitKey && defaultKeyType) || defaultStringType;
      res = _stringify(t);
      if (res === null) throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS(exports => {
  var anchors = require_anchors();
  var identity = require_identity();
  var stringifyComment = require_stringifyComment();
  var stringifyString = require_stringifyString();
  function createStringifyContext(doc, options) {
    const opt = Object.assign(
      {
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: 'PLAIN',
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: 'false',
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: 'null',
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: 'true',
        verifyAliasOrder: true,
      },
      doc.schema.toStringOptions,
      options,
    );
    let inFlow;
    switch (opt.collectionStyle) {
      case 'block':
        inFlow = false;
        break;
      case 'flow':
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set(),
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? ' ' : '',
      indent: '',
      indentStep: typeof opt.indent === 'number' ? ' '.repeat(opt.indent) : '  ',
      inFlow,
      options: opt,
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match2 = tags.filter(t => t.tag === item.tag);
      if (match2.length > 0) return match2.find(t => t.format === item.format) ?? match2[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match2 = tags.filter(t => t.identify?.(obj));
      if (match2.length > 1) {
        const testMatch = match2.filter(t => t.test);
        if (testMatch.length > 0) match2 = testMatch;
      }
      tagObj = match2.find(t => t.format === item.format) ?? match2.find(t => !t.format);
    } else {
      obj = item;
      tagObj = tags.find(t => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? 'null' : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives) return '';
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag) props.push(doc.directives.tagString(tag));
    return props.join(' ');
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item)) return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives) return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases) ctx.resolvedAliases.add(item);
        else ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: o => (tagObj = o) });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0) ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str =
      typeof tagObj.stringify === 'function'
        ? tagObj.stringify(node, ctx, onComment, onChompKeep)
        : identity.isScalar(node)
          ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep)
          : node.toString(ctx, onComment, onChompKeep);
    if (!props) return str;
    return identity.isScalar(node) || str[0] === '{' || str[0] === '['
      ? `${props} ${str}`
      : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS(exports => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const {
      allNullValues,
      doc,
      indent: indent2,
      indentStep,
      options: { commentString, indentSeq, simpleKeys },
    } = ctx;
    let keyComment = (identity.isNode(key) && key.comment) || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error('With simple keys, key nodes cannot have comments');
      }
      if (identity.isCollection(key) || (!identity.isNode(key) && typeof key === 'object')) {
        const msg = 'With simple keys, collection cannot be used as a key value';
        throw new Error(msg);
      }
    }
    let explicitKey =
      !simpleKeys &&
      (!key ||
        (keyComment && value == null && !ctx.inFlow) ||
        identity.isCollection(key) ||
        (identity.isScalar(key)
          ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL
          : typeof key === 'object'));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent2 + indentStep,
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(
      key,
      ctx,
      () => (keyCommentDone = true),
      () => (chompKeep = true),
    );
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys) throw new Error('With simple keys, single line scalar must not span more than 1024 characters');
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment) onComment();
        return str === '' ? '?' : explicitKey ? `? ${str}` : str;
      }
    } else if ((allNullValues && !simpleKeys) || (value == null && explicitKey)) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep) onChompKeep();
      return str;
    }
    if (keyCommentDone) keyComment = null;
    if (explicitKey) {
      if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent2}:`;
    } else {
      str = `${str}:`;
      if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === 'object') value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value)) ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (
      !indentSeq &&
      indentStep.length >= 2 &&
      !ctx.inFlow &&
      !explicitKey &&
      identity.isSeq(value) &&
      !value.flow &&
      !value.tag &&
      !value.anchor
    ) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(
      value,
      ctx,
      () => (valueCommentDone = true),
      () => (chompKeep = true),
    );
    let ws = ' ';
    if (keyComment || vsb || vcb) {
      ws = vsb
        ? `
`
        : '';
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === '' && !ctx.inFlow) {
        if (
          ws ===
            `
` &&
          valueComment
        )
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === '&' || vs0 === '!')) {
          let sp0 = valueStr.indexOf(' ');
          if (vs0 === '&' && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === '!') {
            sp0 = valueStr.indexOf(' ', sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0) hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (
      valueStr === '' ||
      valueStr[0] ===
        `
`
    ) {
      ws = '';
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment) onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS(exports => {
  var node_process = __require('process');
  function debug(logLevel, ...messages) {
    if (logLevel === 'debug') console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === 'debug' || logLevel === 'warn') {
      if (typeof node_process.emitWarning === 'function') node_process.emitWarning(warning);
      else console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS(exports => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var MERGE_KEY = '<<';
  var merge = {
    identify: value => value === MERGE_KEY || (typeof value === 'symbol' && value.description === MERGE_KEY),
    default: 'key',
    tag: 'tag:yaml.org,2002:merge',
    test: /^<<$/,
    resolve: () =>
      Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap,
      }),
    stringify: () => MERGE_KEY,
  };
  var isMergeKey = (ctx, key) =>
    (merge.identify(key) ||
      (identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value))) &&
    ctx?.doc.schema.tags.some(tag => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    value = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (identity.isSeq(value)) for (const it of value.items) mergeValue(ctx, map, it);
    else if (Array.isArray(value)) for (const it of value) mergeValue(ctx, map, it);
    else mergeValue(ctx, map, value);
  }
  function mergeValue(ctx, map, value) {
    const source = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (!identity.isMap(source)) throw new Error('Merge sources must be maps or map aliases');
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value2] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key)) map.set(key, value2);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value: value2,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return map;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS(exports => {
  var log = require_log();
  var merge = require_merge();
  var stringify = require_stringify();
  var identity = require_identity();
  var toJS = require_toJS();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap) key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key)) merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, '', ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        else map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null) return '';
    if (typeof jsKey !== 'object') return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set();
      for (const node of ctx.anchors.keys()) strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40) jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(
          ctx.doc.options.logLevel,
          `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`,
        );
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS(exports => {
  var createNode = require_createNode();
  var stringifyPair = require_stringifyPair();
  var addPairToJSMap = require_addPairToJSMap();
  var identity = require_identity();
  function createPair(key, value, ctx) {
    const k = createNode.createNode(key, undefined, ctx);
    const v = createNode.createNode(value, undefined, ctx);
    return new Pair(k, v);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key)) key = key.clone(schema);
      if (identity.isNode(value)) value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_, ctx) {
      const pair = ctx?.mapAsMap ? new Map() : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS(exports => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify2(collection, ctx, options);
  }
  function stringifyBlockCollection(
    { comment, items },
    ctx,
    { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment },
  ) {
    const {
      indent: indent2,
      options: { commentString },
    } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0; i < items.length; ++i) {
      const item = items[i];
      let comment2 = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore) lines.push('');
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment) comment2 = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore) lines.push('');
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str2 = stringify.stringify(
        item,
        itemCtx,
        () => (comment2 = null),
        () => (chompKeep = true),
      );
      if (comment2) str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
      if (chompKeep && comment2) chompKeep = false;
      lines.push(blockItemPrefix + str2);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1; i < lines.length; ++i) {
        const line = lines[i];
        str += line
          ? `
${indent2}${line}`
          : `
`;
      }
    }
    if (comment) {
      str +=
        `
` + stringifyComment.indentComment(commentString(comment), indent2);
      if (onComment) onComment();
    } else if (chompKeep && onChompKeep) onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const {
      indent: indent2,
      indentStep,
      flowCollectionPadding: fcPadding,
      options: { commentString },
    } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null,
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0; i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore) lines.push('');
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment) comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore) lines.push('');
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment) reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment) comment = iv.comment;
          if (iv.commentBefore) reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment) reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => (comment = null));
      reqNewline ||
        (reqNewline =
          lines.length > linesAtValue ||
          str.includes(`
`));
      if (i < items.length - 1) {
        str += ',';
      } else if (ctx.options.trailingComma) {
        if (ctx.options.lineWidth > 0) {
          reqNewline ||
            (reqNewline =
              lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
        }
        if (reqNewline) {
          str += ',';
        }
      }
      if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line
            ? `
${indentStep}${indent2}${line}`
            : `
`;
        return `${str}
${indent2}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(' ')}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent: indent2, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep) comment = comment.replace(/^\n+/, '');
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent2);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS(exports => {
  var stringifyCollection = require_stringifyCollection();
  var addPairToJSMap = require_addPairToJSMap();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  function findPair(items, key) {
    const k = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k) return it;
        if (identity.isScalar(it.key) && it.key.value === k) return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return 'tag:yaml.org,2002:map';
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === 'function') value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key)) return;
        if (value !== undefined || keepUndefined) map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj) add(key, value);
      } else if (obj && typeof obj === 'object') {
        for (const key of Object.keys(obj)) add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === 'function') {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair)) _pair = pair;
      else if (!pair || typeof pair !== 'object' || !('key' in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite) throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value)) prev.value.value = _pair.value;
        else prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex(item => sortEntries(_pair, item) < 0);
        if (i === -1) this.items.push(_pair);
        else this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it) return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_, ctx, Type) {
      const map = Type ? new Type() : ctx?.mapAsMap ? new Map() : {};
      if (ctx?.onCreate) ctx.onCreate(map);
      for (const item of this.items) addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx) return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false)) ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: '',
        flowChars: { start: '{', end: '}' },
        itemIndent: ctx.indent || '',
        onChompKeep,
        onComment,
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS(exports => {
  var identity = require_identity();
  var YAMLMap = require_YAMLMap();
  var map = {
    collection: 'map',
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: 'tag:yaml.org,2002:map',
    resolve(map2, onError) {
      if (!identity.isMap(map2)) onError('Expected a mapping for this tag');
      return map2;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx),
  };
  exports.map = map;
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS(exports => {
  var createNode = require_createNode();
  var stringifyCollection = require_stringifyCollection();
  var Collection = require_Collection();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var toJS = require_toJS();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return 'tag:yaml.org,2002:seq';
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== 'number') return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== 'number') return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === 'number' && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== 'number') throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value)) prev.value = value;
      else this.items[idx] = value;
    }
    toJSON(_, ctx) {
      const seq = [];
      if (ctx?.onCreate) ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items) seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx) return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: '- ',
        flowChars: { start: '[', end: ']' },
        itemIndent: (ctx.indent || '') + '  ',
        onChompKeep,
        onComment,
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === 'function') {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === 'string') idx = Number(idx);
    return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS(exports => {
  var identity = require_identity();
  var YAMLSeq = require_YAMLSeq();
  var seq = {
    collection: 'seq',
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: 'tag:yaml.org,2002:seq',
    resolve(seq2, onError) {
      if (!identity.isSeq(seq2)) onError('Expected a sequence for this tag');
      return seq2;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx),
  };
  exports.seq = seq;
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS(exports => {
  var stringifyString = require_stringifyString();
  var string = {
    identify: value => typeof value === 'string',
    default: true,
    tag: 'tag:yaml.org,2002:str',
    resolve: str => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    },
  };
  exports.string = string;
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS(exports => {
  var Scalar = require_Scalar();
  var nullTag = {
    identify: value => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: 'tag:yaml.org,2002:null',
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) =>
      typeof source === 'string' && nullTag.test.test(source) ? source : ctx.options.nullStr,
  };
  exports.nullTag = nullTag;
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS(exports => {
  var Scalar = require_Scalar();
  var boolTag = {
    identify: value => typeof value === 'boolean',
    default: true,
    tag: 'tag:yaml.org,2002:bool',
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: str => new Scalar.Scalar(str[0] === 't' || str[0] === 'T'),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === 't' || source[0] === 'T';
        if (value === sv) return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    },
  };
  exports.boolTag = boolTag;
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS(exports => {
  function stringifyNumber({ format: format2, minFractionDigits, tag, value }) {
    if (typeof value === 'bigint') return String(value);
    const num = typeof value === 'number' ? value : Number(value);
    if (!isFinite(num)) return isNaN(num) ? '.nan' : num < 0 ? '-.inf' : '.inf';
    let n = Object.is(value, -0) ? '-0' : JSON.stringify(value);
    if (!format2 && minFractionDigits && (!tag || tag === 'tag:yaml.org,2002:float') && /^\d/.test(n)) {
      let i = n.indexOf('.');
      if (i < 0) {
        i = n.length;
        n += '.';
      }
      let d = minFractionDigits - (n.length - i - 1);
      while (d-- > 0) n += '0';
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS(exports => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: str =>
      str.slice(-3).toLowerCase() === 'nan'
        ? NaN
        : str[0] === '-'
          ? Number.NEGATIVE_INFINITY
          : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber,
  };
  var floatExp = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    format: 'EXP',
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: str => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    },
  };
  var float = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf('.');
      if (dot !== -1 && str[str.length - 1] === '0') node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber,
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS(exports => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = value => typeof value === 'bigint' || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) =>
    intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0) return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: value => intIdentify(value) && value >= 0,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    format: 'OCT',
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: node => intStringify(node, 8, '0o'),
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber,
  };
  var intHex = {
    identify: value => intIdentify(value) && value >= 0,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    format: 'HEX',
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: node => intStringify(node, 16, '0x'),
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS(exports => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
  ];
  exports.schema = schema;
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS(exports => {
  var Scalar = require_Scalar();
  var map = require_map();
  var seq = require_seq();
  function intIdentify(value) {
    return typeof value === 'bigint' || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: value => typeof value === 'string',
      default: true,
      tag: 'tag:yaml.org,2002:str',
      resolve: str => str,
      stringify: stringifyJSON,
    },
    {
      identify: value => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: 'tag:yaml.org,2002:null',
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON,
    },
    {
      identify: value => typeof value === 'boolean',
      default: true,
      tag: 'tag:yaml.org,2002:bool',
      test: /^true$|^false$/,
      resolve: str => str === 'true',
      stringify: stringifyJSON,
    },
    {
      identify: intIdentify,
      default: true,
      tag: 'tag:yaml.org,2002:int',
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => (intAsBigInt ? BigInt(str) : parseInt(str, 10)),
      stringify: ({ value }) => (intIdentify(value) ? value.toString() : JSON.stringify(value)),
    },
    {
      identify: value => typeof value === 'number',
      default: true,
      tag: 'tag:yaml.org,2002:float',
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: str => parseFloat(str),
      stringify: stringifyJSON,
    },
  ];
  var jsonError = {
    default: true,
    tag: '',
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    },
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS(exports => {
  var node_buffer = __require('buffer');
  var Scalar = require_Scalar();
  var stringifyString = require_stringifyString();
  var binary = {
    identify: value => value instanceof Uint8Array,
    default: false,
    tag: 'tag:yaml.org,2002:binary',
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === 'function') {
        return node_buffer.Buffer.from(src, 'base64');
      } else if (typeof atob === 'function') {
        const str = atob(src.replace(/[\n\r]/g, ''));
        const buffer = new Uint8Array(str.length);
        for (let i = 0; i < str.length; ++i) buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError('This environment does not support reading binary tags; either Buffer or atob is required');
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value) return '';
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === 'function') {
        str =
          buf instanceof node_buffer.Buffer
            ? buf.toString('base64')
            : node_buffer.Buffer.from(buf.buffer).toString('base64');
      } else if (typeof btoa === 'function') {
        let s = '';
        for (let i = 0; i < buf.length; ++i) s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error('This environment does not support writing binary tags; either Buffer or btoa is required');
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(
          type === Scalar.Scalar.BLOCK_LITERAL
            ? `
`
            : ' ',
        );
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    },
  };
  exports.binary = binary;
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS(exports => {
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLSeq = require_YAMLSeq();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0; i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item)) continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1) onError('Each pair must have its own sequence indicator');
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore
              ? `${item.commentBefore}
${pair.key.commentBefore}`
              : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment
              ? `${item.comment}
${cn.comment}`
              : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else onError('Expected a sequence for this tag');
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs2 = new YAMLSeq.YAMLSeq(schema);
    pairs2.tag = 'tag:yaml.org,2002:pairs';
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === 'function') it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs2.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs2;
  }
  var pairs = {
    collection: 'seq',
    default: false,
    tag: 'tag:yaml.org,2002:pairs',
    resolve: resolvePairs,
    createNode: createPairs,
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS(exports => {
  var identity = require_identity();
  var toJS = require_toJS();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var pairs = require_pairs();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_, ctx) {
      if (!ctx) return super.toJSON(_);
      const map = new Map();
      if (ctx?.onCreate) ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, '', ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, '', ctx);
        }
        if (map.has(key)) throw new Error('Ordered maps must not include duplicate keys');
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap2 = new this();
      omap2.items = pairs$1.items;
      return omap2;
    }
  }
  YAMLOMap.tag = 'tag:yaml.org,2002:omap';
  var omap = {
    collection: 'seq',
    identify: value => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: 'tag:yaml.org,2002:omap',
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap(), pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx),
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS(exports => {
  var Scalar = require_Scalar();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source)) return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: value => value === true,
    default: true,
    tag: 'tag:yaml.org,2002:bool',
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify,
  };
  var falseTag = {
    identify: value => value === false,
    default: true,
    tag: 'tag:yaml.org,2002:bool',
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify,
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS(exports => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: str =>
      str.slice(-3).toLowerCase() === 'nan'
        ? NaN
        : str[0] === '-'
          ? Number.NEGATIVE_INFINITY
          : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber,
  };
  var floatExp = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    format: 'EXP',
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: str => parseFloat(str.replace(/_/g, '')),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    },
  };
  var float = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, '')));
      const dot = str.indexOf('.');
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, '');
        if (f[f.length - 1] === '0') node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber,
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS(exports => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = value => typeof value === 'bigint' || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === '-' || sign === '+') offset += 1;
    str = str.substring(offset).replace(/_/g, '');
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n2 = BigInt(str);
      return sign === '-' ? BigInt(-1) * n2 : n2;
    }
    const n = parseInt(str, radix);
    return sign === '-' ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? '-' + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    format: 'BIN',
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: node => intStringify(node, 2, '0b'),
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    format: 'OCT',
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: node => intStringify(node, 8, '0'),
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber,
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: 'tag:yaml.org,2002:int',
    format: 'HEX',
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: node => intStringify(node, 16, '0x'),
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS(exports => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key)) pair = key;
      else if (key && typeof key === 'object' && 'key' in key && 'value' in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev) this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? (identity.isScalar(pair.key) ? pair.key.value : pair.key) : pair;
    }
    set(key, value) {
      if (typeof value !== 'boolean')
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_, ctx) {
      return super.toJSON(_, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx) return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else throw new Error('Set items must all have null values');
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set2 = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === 'function') value = replacer.call(iterable, value, value);
          set2.items.push(Pair.createPair(value, null, ctx));
        }
      return set2;
    }
  }
  YAMLSet.tag = 'tag:yaml.org,2002:set';
  var set = {
    collection: 'map',
    identify: value => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: 'tag:yaml.org,2002:set',
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true)) return Object.assign(new YAMLSet(), map);
        else onError('Set items must all have null values');
      } else onError('Expected a mapping for this tag');
      return map;
    },
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS(exports => {
  var stringifyNumber = require_stringifyNumber();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === '-' || sign === '+' ? str.substring(1) : str;
    const num = n => (asBigInt ? BigInt(n) : Number(n));
    const res = parts
      .replace(/_/g, '')
      .split(':')
      .reduce((res2, p) => res2 * num(60) + num(p), num(0));
    return sign === '-' ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = n => n;
    if (typeof value === 'bigint') num = n => BigInt(n);
    else if (isNaN(value) || !isFinite(value)) return stringifyNumber.stringifyNumber(node);
    let sign = '';
    if (value < 0) {
      sign = '-';
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return (
      sign +
      parts
        .map(n => String(n).padStart(2, '0'))
        .join(':')
        .replace(/000000\d*$/, '')
    );
  }
  var intTime = {
    identify: value => typeof value === 'bigint' || Number.isInteger(value),
    default: true,
    tag: 'tag:yaml.org,2002:int',
    format: 'TIME',
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal,
  };
  var floatTime = {
    identify: value => typeof value === 'number',
    default: true,
    tag: 'tag:yaml.org,2002:float',
    format: 'TIME',
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: str => parseSexagesimal(str, false),
    stringify: stringifySexagesimal,
  };
  var timestamp = {
    identify: value => value instanceof Date,
    default: true,
    tag: 'tag:yaml.org,2002:timestamp',
    test: RegExp(
      '^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})' +
        '(?:' +
        '(?:t|T|[ \\t]+)' +
        '([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)' +
        '(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?' +
        ')?$',
    ),
    resolve(str) {
      const match2 = str.match(timestamp.test);
      if (!match2) throw new Error('!!timestamp expects a date, starting with yyyy-mm-dd');
      const [, year, month, day, hour, minute, second] = match2.map(Number);
      const millisec = match2[7] ? Number((match2[7] + '00').substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match2[8];
      if (tz && tz !== 'Z') {
        let d = parseSexagesimal(tz, false);
        if (Math.abs(d) < 30) d *= 60;
        date -= 60000 * d;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, '') ?? '',
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS(exports => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var binary = require_binary();
  var bool = require_bool2();
  var float = require_float2();
  var int = require_int2();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var set = require_set();
  var timestamp = require_timestamp();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp,
  ];
  exports.schema = schema;
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS(exports => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = require_schema();
  var schema$1 = require_schema2();
  var binary = require_binary();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var schema$2 = require_schema3();
  var set = require_set();
  var timestamp = require_timestamp();
  var schemas = new Map([
    ['core', schema.schema],
    ['failsafe', [map.map, seq.seq, string.string]],
    ['json', schema$1.schema],
    ['yaml11', schema$2.schema],
    ['yaml-1.1', schema$2.schema],
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp,
  };
  var coreKnownTags = {
    'tag:yaml.org,2002:binary': binary.binary,
    'tag:yaml.org,2002:merge': merge.merge,
    'tag:yaml.org,2002:omap': omap.omap,
    'tag:yaml.org,2002:pairs': pairs.pairs,
    'tag:yaml.org,2002:set': set.set,
    'tag:yaml.org,2002:timestamp': timestamp.timestamp,
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags)) tags = [];
      else {
        const keys = Array.from(schemas.keys())
          .filter(key => key !== 'yaml11')
          .map(key => JSON.stringify(key))
          .join(', ');
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags) tags = tags.concat(tag);
    } else if (typeof customTags === 'function') {
      tags = customTags(tags.slice());
    }
    if (addMergeTag) tags = tags.concat(merge.merge);
    return tags.reduce((tags2, tag) => {
      const tagObj = typeof tag === 'string' ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName)
          .map(key => JSON.stringify(key))
          .join(', ');
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags2.includes(tagObj)) tags2.push(tagObj);
      return tags2;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS(exports => {
  var identity = require_identity();
  var map = require_map();
  var seq = require_seq();
  var string = require_string();
  var tags = require_tags();
  var sortMapEntriesByKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, 'compat') : compat ? tags.getTags(null, compat) : null;
      this.name = (typeof schema === 'string' && schema) || 'core';
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries =
        typeof sortMapEntries === 'function' ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS(exports => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart) hasDirectives = true;
    }
    if (hasDirectives) lines.push('---');
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1) lines.unshift('');
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ''));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives) lines.push('');
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ''));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => (chompKeep = true);
      let body = stringify.stringify(doc.contents, ctx, () => (contentComment = null), onChompKeep);
      if (contentComment) body += stringifyComment.lineComment(body, '', commentString(contentComment));
      if ((body[0] === '|' || body[0] === '>') && lines[lines.length - 1] === '---') {
        lines[lines.length - 1] = `--- ${body}`;
      } else lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (
          cs.includes(`
`)
        ) {
          lines.push('...');
          lines.push(stringifyComment.indentComment(cs, ''));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push('...');
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep) dc = dc.replace(/^\n+/, '');
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== '') lines.push('');
        lines.push(stringifyComment.indentComment(commentString(dc), ''));
      }
    }
    return (
      lines.join(`
`) +
      `
`
    );
  }
  exports.stringifyDocument = stringifyDocument;
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS(exports => {
  var Alias = require_Alias();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var toJS = require_toJS();
  var Schema = require_Schema();
  var stringifyDocument = require_stringifyDocument();
  var anchors = require_anchors();
  var applyReviver = require_applyReviver();
  var createNode = require_createNode();
  var directives = require_directives();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === 'function' || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign(
        {
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: 'warn',
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: '1.2',
        },
        options,
      );
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit) version = this.directives.yaml.version;
      } else this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC },
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives) copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range) copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents)) this.contents.add(value);
    }
    addIn(path5, value) {
      if (assertCollection(this.contents)) this.contents.addIn(path5, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || 'a', prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === 'function') {
        value = replacer.call({ '': value }, '', value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = v => typeof v === 'number' || v instanceof String || v instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0) replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || 'a');
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects,
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node)) node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k = this.createNode(key, null, options);
      const v = this.createNode(value, null, options);
      return new Pair.Pair(k, v);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path5) {
      if (Collection.isEmptyPath(path5)) {
        if (this.contents == null) return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path5) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path5, keepScalar) {
      if (Collection.isEmptyPath(path5))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path5, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path5) {
      if (Collection.isEmptyPath(path5)) return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path5) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path5, value) {
      if (Collection.isEmptyPath(path5)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path5), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path5, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === 'number') version = String(version);
      let opt;
      switch (version) {
        case '1.1':
          if (this.directives) this.directives.yaml.version = '1.1';
          else this.directives = new directives.Directives({ version: '1.1' });
          opt = { resolveKnownTags: false, schema: 'yaml-1.1' };
          break;
        case '1.2':
        case 'next':
          if (this.directives) this.directives.yaml.version = version;
          else this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: 'core' };
          break;
        case null:
          if (this.directives) delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object) this.schema = options.schema;
      else if (opt) this.schema = new Schema.Schema(Object.assign(opt, options));
      else throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map(),
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === 'number' ? maxAliasCount : 100,
      };
      const res = toJS.toJS(this.contents, jsonArg ?? '', ctx);
      if (typeof onAnchor === 'function')
        for (const { count, res: res2 } of ctx.anchors.values()) onAnchor(res2, count);
      return typeof reviver === 'function' ? applyReviver.applyReviver(reviver, { '': res }, '', res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0) throw new Error('Document with errors cannot be stringified');
      if ('indent' in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents)) return true;
    throw new Error('Expected a YAML collection as document contents');
  }
  exports.Document = Document;
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS(exports => {
  class YAMLError extends Error {
    constructor(name, pos, code, message2) {
      super();
      this.name = name;
      this.code = code;
      this.message = message2;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message2) {
      super('YAMLParseError', pos, code, message2);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message2) {
      super('YAMLWarning', pos, code, message2);
    }
  }
  var prettifyError = (src, lc) => error => {
    if (error.pos[0] === -1) return;
    error.linePos = error.pos.map(pos => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, '');
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = '\u2026' + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80) lineStr = lineStr.substring(0, 79) + '\u2026';
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev =
          prev.substring(0, 79) +
          `\u2026
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = ' '.repeat(ci) + '^'.repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS(exports => {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = '';
    let commentSep = '';
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== 'space' && token.type !== 'newline' && token.type !== 'comma')
          onError(
            token.offset,
            'MISSING_CHAR',
            'Tags and anchors must be separated from the next token by white space',
          );
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== 'comment' && token.type !== 'newline') {
          onError(tab, 'TAB_AS_INDENT', 'Tabs are not allowed as indentation');
        }
        tab = null;
      }
      switch (token.type) {
        case 'space':
          if (!flow && (indicator !== 'doc-start' || next?.type !== 'flow-collection') && token.source.includes('\t')) {
            tab = token;
          }
          hasSpace = true;
          break;
        case 'comment': {
          if (!hasSpace)
            onError(token, 'MISSING_CHAR', 'Comments must be separated from other tokens by white space characters');
          const cb = token.source.substring(1) || ' ';
          if (!comment) comment = cb;
          else comment += commentSep + cb;
          commentSep = '';
          atNewline = false;
          break;
        }
        case 'newline':
          if (atNewline) {
            if (comment) comment += token.source;
            else if (!found || indicator !== 'seq-item-ind') spaceBefore = true;
          } else commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag) newlineAfterProp = token;
          hasSpace = true;
          break;
        case 'anchor':
          if (anchor) onError(token, 'MULTIPLE_ANCHORS', 'A node can have at most one anchor');
          if (token.source.endsWith(':'))
            onError(token.offset + token.source.length - 1, 'BAD_ALIAS', 'Anchor ending in : is ambiguous', true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case 'tag': {
          if (tag) onError(token, 'MULTIPLE_TAGS', 'A node can have at most one tag');
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, 'BAD_PROP_ORDER', `Anchors and tags must be after the ${token.source} indicator`);
          if (found) onError(token, 'UNEXPECTED_TOKEN', `Unexpected ${token.source} in ${flow ?? 'collection'}`);
          found = token;
          atNewline = indicator === 'seq-item-ind' || indicator === 'explicit-key-ind';
          hasSpace = false;
          break;
        case 'comma':
          if (flow) {
            if (comma) onError(token, 'UNEXPECTED_TOKEN', `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, 'UNEXPECTED_TOKEN', `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (
      reqSpace &&
      next &&
      next.type !== 'space' &&
      next.type !== 'newline' &&
      next.type !== 'comma' &&
      (next.type !== 'scalar' || next.source !== '')
    ) {
      onError(next.offset, 'MISSING_CHAR', 'Tags and anchors must be separated from the next token by white space');
    }
    if (tab && ((atNewline && tab.indent <= parentIndent) || next?.type === 'block-map' || next?.type === 'block-seq'))
      onError(tab, 'TAB_AS_INDENT', 'Tabs are not allowed as indentation');
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end,
    };
  }
  exports.resolveProps = resolveProps;
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS(exports => {
  function containsNewline(key) {
    if (!key) return null;
    switch (key.type) {
      case 'alias':
      case 'scalar':
      case 'double-quoted-scalar':
      case 'single-quoted-scalar':
        if (
          key.source.includes(`
`)
        )
          return true;
        if (key.end) {
          for (const st of key.end) if (st.type === 'newline') return true;
        }
        return false;
      case 'flow-collection':
        for (const it of key.items) {
          for (const st of it.start) if (st.type === 'newline') return true;
          if (it.sep) {
            for (const st of it.sep) if (st.type === 'newline') return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value)) return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS(exports => {
  var utilContainsNewline = require_util_contains_newline();
  function flowIndentCheck(indent2, fc, onError) {
    if (fc?.type === 'flow-collection') {
      const end = fc.end[0];
      if (
        end.indent === indent2 &&
        (end.source === ']' || end.source === '}') &&
        utilContainsNewline.containsNewline(fc)
      ) {
        const msg = 'Flow end indicator should be more indented than parent';
        onError(end, 'BAD_INDENT', msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS(exports => {
  var identity = require_identity();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false) return false;
    const isEqual =
      typeof uniqueKeys === 'function'
        ? uniqueKeys
        : (a, b) => a === b || (identity.isScalar(a) && identity.isScalar(b) && a.value === b.value);
    return items.some(pair => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS(exports => {
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  var utilMapIncludes = require_util_map_includes();
  var startColMsg = 'All mapping items must start at the same column';
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot) ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: 'explicit-key-ind',
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true,
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === 'block-seq')
            onError(offset, 'BLOCK_AS_IMPLICIT_KEY', 'A block sequence may not be used as an implicit map key');
          else if ('indent' in key && key.indent !== bm.indent) onError(offset, 'BAD_INDENT', startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment +=
                `
` + keyProps.comment;
            else map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(
            key ?? start[start.length - 1],
            'MULTILINE_IMPLICIT_KEY',
            'Implicit keys need to be on a single line',
          );
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, 'BAD_INDENT', startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key
        ? composeNode(ctx, key, keyProps, onError)
        : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, 'DUPLICATE_KEY', 'Map keys must be unique');
      const valueProps = resolveProps.resolveProps(sep ?? [], {
        indicator: 'map-value-ind',
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === 'block-scalar',
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === 'block-map' && !valueProps.hasNewline)
            onError(offset, 'BLOCK_AS_IMPLICIT_KEY', 'Nested mappings are not allowed in compact mappings');
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(
              keyNode.range,
              'KEY_OVER_1024_CHARS',
              'The : indicator must be at most 1024 chars after the start of an implicit block mapping key',
            );
        }
        const valueNode = value
          ? composeNode(ctx, value, valueProps, onError)
          : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
        if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey) onError(keyNode.range, 'MISSING_CHAR', 'Implicit map keys need to be followed by map values');
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment +=
              `
` + valueProps.comment;
          else keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset) onError(commentEnd, 'IMPOSSIBLE', 'Map comment with trailing content');
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS(exports => {
  var YAMLSeq = require_YAMLSeq();
  var resolveProps = require_resolve_props();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot) ctx.atRoot = false;
    if (ctx.atKey) ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: 'seq-item-ind',
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true,
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === 'block-seq')
            onError(props.end, 'BAD_INDENT', 'All sequence items must start at the same column');
          else onError(offset, 'MISSING_CHAR', 'Sequence item without - indicator');
        } else {
          commentEnd = props.end;
          if (props.comment) seq.comment = props.comment;
          continue;
        }
      }
      const node = value
        ? composeNode(ctx, value, props, onError)
        : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS(exports => {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = '';
    if (end) {
      let hasSpace = false;
      let sep = '';
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case 'space':
            hasSpace = true;
            break;
          case 'comment': {
            if (reqSpace && !hasSpace)
              onError(token, 'MISSING_CHAR', 'Comments must be separated from other tokens by white space characters');
            const cb = source.substring(1) || ' ';
            if (!comment) comment = cb;
            else comment += sep + cb;
            sep = '';
            break;
          }
          case 'newline':
            if (comment) sep += source;
            hasSpace = true;
            break;
          default:
            onError(token, 'UNEXPECTED_TOKEN', `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS(exports => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilMapIncludes = require_util_map_includes();
  var blockMsg = 'Block collections are not allowed within flow collections';
  var isBlock = token => token && (token.type === 'block-map' || token.type === 'block-seq');
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === '{';
    const fcName = isMap ? 'flow map' : 'flow sequence';
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot) ctx.atRoot = false;
    if (ctx.atKey) ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0; i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: 'explicit-key-ind',
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false,
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep && !value) {
          if (i === 0 && props.comma) onError(props.comma, 'UNEXPECTED_TOKEN', `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, 'UNEXPECTED_TOKEN', `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment +=
                `
` + props.comment;
            else coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, 'MULTILINE_IMPLICIT_KEY', 'Implicit keys of flow sequence pairs need to be on a single line');
      }
      if (i === 0) {
        if (props.comma) onError(props.comma, 'UNEXPECTED_TOKEN', `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma) onError(props.start, 'MISSING_CHAR', `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = '';
          loop: for (const st of start) {
            switch (st.type) {
              case 'comma':
              case 'space':
                break;
              case 'comment':
                prevItemComment = st.source.substring(1);
                break loop;
              default:
                break loop;
            }
          }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev)) prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment +=
                `
` + prevItemComment;
            else prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep && !props.found) {
        const valueNode = value
          ? composeNode(ctx, value, props, onError)
          : composeEmptyNode(ctx, props.end, sep, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value)) onError(valueNode.range, 'BLOCK_IN_FLOW', blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key
          ? composeNode(ctx, key, props, onError)
          : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key)) onError(keyNode.range, 'BLOCK_IN_FLOW', blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          flow: fcName,
          indicator: 'map-value-ind',
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false,
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep)
              for (const st of sep) {
                if (st === valueProps.found) break;
                if (st.type === 'newline') {
                  onError(
                    st,
                    'MULTILINE_IMPLICIT_KEY',
                    'Implicit keys of flow sequence pairs need to be on a single line',
                  );
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(
                valueProps.found,
                'KEY_OVER_1024_CHARS',
                'The : indicator must be at most 1024 chars after the start of an implicit flow sequence key',
              );
          }
        } else if (value) {
          if ('source' in value && value.source?.[0] === ':')
            onError(value, 'MISSING_CHAR', `Missing space after : in ${fcName}`);
          else onError(valueProps.start, 'MISSING_CHAR', `Missing , or : between ${fcName} items`);
        }
        const valueNode = value
          ? composeNode(ctx, value, valueProps, onError)
          : valueProps.found
            ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError)
            : null;
        if (valueNode) {
          if (isBlock(value)) onError(valueNode.range, 'BLOCK_IN_FLOW', blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment +=
              `
` + valueProps.comment;
          else keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, 'DUPLICATE_KEY', 'Map keys must be unique');
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? '}' : ']';
    const [ce, ...ee] = fc.end;
    let cePos = offset;
    if (ce?.source === expectedEnd) cePos = ce.offset + ce.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot
        ? `${name} must end with a ${expectedEnd}`
        : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? 'MISSING_CHAR' : 'BAD_INDENT', msg);
      if (ce && ce.source.length !== 1) ee.unshift(ce);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment +=
            `
` + end.comment;
        else coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS(exports => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveBlockMap = require_resolve_block_map();
  var resolveBlockSeq = require_resolve_block_seq();
  var resolveFlowCollection = require_resolve_flow_collection();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll =
      token.type === 'block-map'
        ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag)
        : token.type === 'block-seq'
          ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag)
          : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === '!' || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName) coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken
      ? null
      : ctx.directives.tagName(tagToken.source, msg => onError(tagToken, 'TAG_RESOLVE_FAILED', msg));
    if (token.type === 'block-seq') {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp =
        anchor && tagToken ? (anchor.offset > tagToken.offset ? anchor : tagToken) : (anchor ?? tagToken);
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message2 = 'Missing newline after block sequence props';
        onError(lastProp, 'MISSING_CHAR', message2);
      }
    }
    const expType =
      token.type === 'block-map'
        ? 'map'
        : token.type === 'block-seq'
          ? 'seq'
          : token.start.source === '{'
            ? 'map'
            : 'seq';
    if (
      !tagToken ||
      !tagName ||
      tagName === '!' ||
      (tagName === YAMLMap.YAMLMap.tagName && expType === 'map') ||
      (tagName === YAMLSeq.YAMLSeq.tagName && expType === 'seq')
    ) {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find(t => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(
            tagToken,
            'BAD_COLLECTION_TYPE',
            `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? 'scalar'}`,
            true,
          );
        } else {
          onError(tagToken, 'TAG_RESOLVE_FAILED', `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, msg => onError(tagToken, 'TAG_RESOLVE_FAILED', msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format) node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS(exports => {
  var Scalar = require_Scalar();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header) return { value: '', type: null, comment: '', range: [start, start, start] };
    const type = header.mode === '>' ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1; i >= 0; --i) {
      const content = lines[i][1];
      if (content === '' || content === '\r') chompStart = i;
      else break;
    }
    if (chompStart === 0) {
      const value2 =
        header.chomp === '+' && lines.length > 0
          ? `
`.repeat(Math.max(1, lines.length - 1))
          : '';
      let end2 = start + header.length;
      if (scalar.source) end2 += scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0; i < chompStart; ++i) {
      const [indent2, content] = lines[i];
      if (content === '' || content === '\r') {
        if (header.indent === 0 && indent2.length > trimIndent) trimIndent = indent2.length;
      } else {
        if (indent2.length < trimIndent) {
          const message2 =
            'Block scalars with more-indented leading empty lines must use an explicit indentation indicator';
          onError(offset + indent2.length, 'MISSING_CHAR', message2);
        }
        if (header.indent === 0) trimIndent = indent2.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message2 = 'Block scalar values in collections must be indented';
          onError(offset, 'BAD_INDENT', message2);
        }
        break;
      }
      offset += indent2.length + content.length + 1;
    }
    for (let i = lines.length - 1; i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent) chompStart = i + 1;
    }
    let value = '';
    let sep = '';
    let prevMoreIndented = false;
    for (let i = 0; i < contentStart; ++i)
      value +=
        lines[i][0].slice(trimIndent) +
        `
`;
    for (let i = contentStart; i < chompStart; ++i) {
      let [indent2, content] = lines[i];
      offset += indent2.length + content.length + 1;
      const crlf = content[content.length - 1] === '\r';
      if (crlf) content = content.slice(0, -1);
      if (content && indent2.length < trimIndent) {
        const src = header.indent ? 'explicit indentation indicator' : 'first line';
        const message2 = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), 'BAD_INDENT', message2);
        indent2 = '';
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep + indent2.slice(trimIndent) + content;
        sep = `
`;
      } else if (indent2.length > trimIndent || content[0] === '\t') {
        if (sep === ' ')
          sep = `
`;
        else if (
          !prevMoreIndented &&
          sep ===
            `
`
        )
          sep = `

`;
        value += sep + indent2.slice(trimIndent) + content;
        sep = `
`;
        prevMoreIndented = true;
      } else if (content === '') {
        if (
          sep ===
          `
`
        )
          value += `
`;
        else
          sep = `
`;
      } else {
        value += sep + content;
        sep = ' ';
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case '-':
        break;
      case '+':
        for (let i = chompStart; i < lines.length; ++i)
          value +=
            `
` + lines[i][0].slice(trimIndent);
        if (
          value[value.length - 1] !==
          `
`
        )
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== 'block-scalar-header') {
      onError(props[0], 'IMPOSSIBLE', 'Block scalar header not found');
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent2 = 0;
    let chomp = '';
    let error = -1;
    for (let i = 1; i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === '-' || ch === '+')) chomp = ch;
      else {
        const n = Number(ch);
        if (!indent2 && n) indent2 = n;
        else if (error === -1) error = offset + i;
      }
    }
    if (error !== -1) onError(error, 'UNEXPECTED_TOKEN', `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = '';
    let length = source.length;
    for (let i = 1; i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case 'space':
          hasSpace = true;
        case 'newline':
          length += token.source.length;
          break;
        case 'comment':
          if (strict && !hasSpace) {
            const message2 = 'Comments must be separated from other tokens by white space characters';
            onError(token, 'MISSING_CHAR', message2);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case 'error':
          onError(token, 'UNEXPECTED_TOKEN', token.message);
          length += token.source.length;
          break;
        default: {
          const message2 = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, 'UNEXPECTED_TOKEN', message2);
          const ts = token.source;
          if (ts && typeof ts === 'string') length += ts.length;
        }
      }
    }
    return { mode, indent: indent2, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m = first.match(/^( *)/);
    const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ['', first];
    const lines = [line0];
    for (let i = 1; i < split.length; i += 2) lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS(exports => {
  var Scalar = require_Scalar();
  var resolveEnd = require_resolve_end();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case 'scalar':
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case 'single-quoted-scalar':
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case 'double-quoted-scalar':
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, 'UNEXPECTED_TOKEN', `Expected a flow scalar value, but found: ${type}`);
        return {
          value: '',
          type: null,
          comment: '',
          range: [offset, offset + source.length, offset + source.length],
        };
    }
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re.comment,
      range: [offset, valueEnd, re.offset],
    };
  }
  function plainValue(source, onError) {
    let badChar = '';
    switch (source[0]) {
      case '\t':
        badChar = 'a tab character';
        break;
      case ',':
        badChar = 'flow indicator character ,';
        break;
      case '%':
        badChar = 'directive indicator character %';
        break;
      case '|':
      case '>': {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case '@':
      case '`': {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar) onError(0, 'BAD_SCALAR_START', `Plain value cannot start with ${badChar}`);
    return foldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, 'MISSING_CHAR', "Missing closing 'quote");
    return foldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function foldLines(source) {
    let first, line;
    try {
      first = new RegExp(
        `(.*?)(?<![ 	])[ 	]*\r?
`,
        'sy',
      );
      line = new RegExp(
        `[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`,
        'sy',
      );
    } catch {
      first = /(.*?)[ \t]*\r?\n/sy;
      line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
    }
    let match2 = first.exec(source);
    if (!match2) return source;
    let res = match2[1];
    let sep = ' ';
    let pos = first.lastIndex;
    line.lastIndex = pos;
    while ((match2 = line.exec(source))) {
      if (match2[1] === '') {
        if (
          sep ===
          `
`
        )
          res += sep;
        else
          sep = `
`;
      } else {
        res += sep + match2[1];
        sep = ' ';
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match2 = last.exec(source);
    return res + sep + (match2?.[1] ?? '');
  }
  function doubleQuotedValue(source, onError) {
    let res = '';
    for (let i = 1; i < source.length - 1; ++i) {
      const ch = source[i];
      if (
        ch === '\r' &&
        source[i + 1] ===
          `
`
      )
        continue;
      if (
        ch ===
        `
`
      ) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === '\\') {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc) res += cc;
        else if (
          next ===
          `
`
        ) {
          next = source[i + 1];
          while (next === ' ' || next === '\t') next = source[++i + 1];
        } else if (
          next === '\r' &&
          source[i + 1] ===
            `
`
        ) {
          next = source[++i + 1];
          while (next === ' ' || next === '\t') next = source[++i + 1];
        } else if (next === 'x' || next === 'u' || next === 'U') {
          const length = { x: 2, u: 4, U: 8 }[next];
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, 'BAD_DQ_ESCAPE', `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === ' ' || ch === '\t') {
        const wsStart = i;
        let next = source[i + 1];
        while (next === ' ' || next === '\t') next = source[++i + 1];
        if (
          next !==
            `
` &&
          !(
            next === '\r' &&
            source[i + 2] ===
              `
`
          )
        )
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, 'MISSING_CHAR', 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = '';
    let ch = source[offset + 1];
    while (
      ch === ' ' ||
      ch === '\t' ||
      ch ===
        `
` ||
      ch === '\r'
    ) {
      if (
        ch === '\r' &&
        source[offset + 2] !==
          `
`
      )
        break;
      if (
        ch ===
        `
`
      )
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold) fold = ' ';
    return { fold, offset };
  }
  var escapeCodes = {
    0: '\x00',
    a: '\x07',
    b: '\b',
    e: '\x1B',
    f: '\f',
    n: `
`,
    r: '\r',
    t: '\t',
    v: '\v',
    N: '\x85',
    _: '\xA0',
    L: '\u2028',
    P: '\u2029',
    ' ': ' ',
    '"': '"',
    '/': '/',
    '\\': '\\',
    '\t': '\t',
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    if (isNaN(code)) {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, 'BAD_DQ_ESCAPE', `Invalid escape sequence ${raw}`);
      return raw;
    }
    return String.fromCodePoint(code);
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS(exports => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } =
      token.type === 'block-scalar'
        ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError)
        : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken
      ? ctx.directives.tagName(tagToken.source, msg => onError(tagToken, 'TAG_RESOLVE_FAILED', msg))
      : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName) tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === 'scalar') tag = findScalarTagByTest(ctx, value, token, onError);
    else tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, msg => onError(tagToken ?? token, 'TAG_RESOLVE_FAILED', msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, 'TAG_RESOLVE_FAILED', msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type) scalar.type = type;
    if (tagName) scalar.tag = tagName;
    if (tag.format) scalar.format = tag.format;
    if (comment) scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === '!') return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test) matchWithTest.push(tag);
        else return tag;
      }
    }
    for (const tag of matchWithTest) if (tag.test?.test(value)) return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, 'TAG_RESOLVE_FAILED', `Unresolved tag: ${tagName}`, tagName !== 'tag:yaml.org,2002:str');
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag =
      schema.tags.find(
        tag2 => (tag2.default === true || (atKey && tag2.default === 'key')) && tag2.test?.test(value),
      ) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find(tag2 => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, 'TAG_RESOLVE_FAILED', msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS(exports => {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1; i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case 'space':
          case 'comment':
          case 'newline':
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === 'space') {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS(exports => {
  var Alias = require_Alias();
  var identity = require_identity();
  var composeCollection = require_compose_collection();
  var composeScalar = require_compose_scalar();
  var resolveEnd = require_resolve_end();
  var utilEmptyScalarPosition = require_util_empty_scalar_position();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case 'alias':
        node = composeAlias(ctx, token, onError);
        if (anchor || tag) onError(token, 'ALIAS_PROPS', 'An alias node must not specify any properties');
        break;
      case 'scalar':
      case 'single-quoted-scalar':
      case 'double-quoted-scalar':
      case 'block-scalar':
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor) node.anchor = anchor.source.substring(1);
        break;
      case 'block-map':
      case 'block-seq':
      case 'flow-collection':
        try {
          node = composeCollection.composeCollection(CN, ctx, token, props, onError);
          if (anchor) node.anchor = anchor.source.substring(1);
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error);
          onError(token, 'RESOURCE_EXHAUSTION', message2);
        }
        break;
      default: {
        const message2 = token.type === 'error' ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, 'UNEXPECTED_TOKEN', message2);
        isSrcToken = false;
      }
    }
    node ?? (node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError));
    if (anchor && node.anchor === '') onError(anchor, 'BAD_ALIAS', 'Anchor cannot be an empty string');
    if (
      atKey &&
      ctx.options.stringKeys &&
      (!identity.isScalar(node) || typeof node.value !== 'string' || (node.tag && node.tag !== 'tag:yaml.org,2002:str'))
    ) {
      const msg = 'With stringKeys, all keys must be strings';
      onError(tag ?? token, 'NON_STRING_KEY', msg);
    }
    if (spaceBefore) node.spaceBefore = true;
    if (comment) {
      if (token.type === 'scalar' && token.source === '') node.comment = comment;
      else node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken) node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: 'scalar',
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: '',
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === '') onError(anchor, 'BAD_ALIAS', 'Anchor cannot be an empty string');
    }
    if (spaceBefore) node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === '') onError(offset, 'BAD_ALIAS', 'Alias cannot be an empty string');
    if (alias.source.endsWith(':'))
      onError(offset + source.length - 1, 'BAD_ALIAS', 'Alias ending in : is ambiguous', true);
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re.offset];
    if (re.comment) alias.comment = re.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS(exports => {
  var Document = require_Document();
  var composeNode = require_compose_node();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema,
    };
    const props = resolveProps.resolveProps(start, {
      indicator: 'doc-start',
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true,
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === 'block-map' || value.type === 'block-seq') && !props.hasNewline)
        onError(props.end, 'MISSING_CHAR', 'Block collection cannot start on same line with directives-end marker');
    }
    doc.contents = value
      ? composeNode.composeNode(ctx, value, props, onError)
      : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re.comment) doc.comment = re.comment;
    doc.range = [offset, contentEnd, re.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS(exports => {
  var node_process = __require('process');
  var directives = require_directives();
  var Document = require_Document();
  var errors2 = require_errors();
  var identity = require_identity();
  var composeDoc = require_compose_doc();
  var resolveEnd = require_resolve_end();
  function getErrorPos(src) {
    if (typeof src === 'number') return [src, src + 1];
    if (Array.isArray(src)) return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === 'string' ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = '';
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0; i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case '#':
          comment +=
            (comment === ''
              ? ''
              : afterEmptyLine
                ? `

`
                : `
`) + (source.substring(1) || ' ');
          atComment = true;
          afterEmptyLine = false;
          break;
        case '%':
          if (prelude[i + 1]?.[0] !== '#') i += 1;
          atComment = false;
          break;
        default:
          if (!atComment) afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message2, warning) => {
        const pos = getErrorPos(source);
        if (warning) this.warnings.push(new errors2.YAMLWarning(pos, code, message2));
        else this.errors.push(new errors2.YAMLParseError(pos, code, message2));
      };
      this.directives = new directives.Directives({ version: options.version || '1.2' });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment
            ? `${doc.comment}
${comment}`
            : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it)) it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb
            ? `${comment}
${cb}`
            : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb
            ? `${comment}
${cb}`
            : comment;
        }
      }
      if (afterDoc) {
        Array.prototype.push.apply(doc.errors, this.errors);
        Array.prototype.push.apply(doc.warnings, this.warnings);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings,
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens) yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM) console.dir(token, { depth: null });
      switch (token.type) {
        case 'directive':
          this.directives.add(token.source, (offset, message2, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, 'BAD_DIRECTIVE', message2, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case 'document': {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, 'MISSING_CHAR', 'Missing directives-end/doc-start indicator line');
          this.decorate(doc, false);
          if (this.doc) yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case 'byte-order-mark':
        case 'space':
          break;
        case 'comment':
        case 'newline':
          this.prelude.push(token.source);
          break;
        case 'error': {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors2.YAMLParseError(getErrorPos(token), 'UNEXPECTED_TOKEN', msg);
          if (this.atDirectives || !this.doc) this.errors.push(error);
          else this.doc.errors.push(error);
          break;
        }
        case 'doc-end': {
          if (!this.doc) {
            const msg = 'Unexpected doc-end without preceding document';
            this.errors.push(new errors2.YAMLParseError(getErrorPos(token), 'UNEXPECTED_TOKEN', msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(
            token.end,
            token.offset + token.source.length,
            this.doc.options.strict,
            this.onError,
          );
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc
              ? `${dc}
${end.comment}`
              : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(
            new errors2.YAMLParseError(getErrorPos(token), 'UNEXPECTED_TOKEN', `Unsupported token ${token.type}`),
          );
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives) this.onError(endOffset, 'MISSING_CHAR', 'Missing directives-end indicator line');
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS(exports => {
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  var errors2 = require_errors();
  var stringifyString = require_stringifyString();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message2) => {
        const offset = typeof pos === 'number' ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError) onError(offset, code, message2);
        else throw new errors2.YAMLParseError([offset, offset + 1], code, message2);
      };
      switch (token.type) {
        case 'scalar':
        case 'single-quoted-scalar':
        case 'double-quoted-scalar':
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case 'block-scalar':
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent: indent2, inFlow = false, offset = -1, type = 'PLAIN' } = context;
    const source = stringifyString.stringifyString(
      { type, value },
      {
        implicitKey,
        indent: indent2 > 0 ? ' '.repeat(indent2) : '',
        inFlow,
        options: { blockQuote: true, lineWidth: -1 },
      },
    );
    const end = context.end ?? [
      {
        type: 'newline',
        offset: -1,
        indent: indent2,
        source: `
`,
      },
    ];
    switch (source[0]) {
      case '|':
      case '>': {
        const he = source.indexOf(`
`);
        const head = source.substring(0, he);
        const body =
          source.substring(he + 1) +
          `
`;
        const props = [{ type: 'block-scalar-header', offset, indent: indent2, source: head }];
        if (!addEndtoBlockProps(props, end))
          props.push({
            type: 'newline',
            offset: -1,
            indent: indent2,
            source: `
`,
          });
        return { type: 'block-scalar', offset, indent: indent2, props, source: body };
      }
      case '"':
        return { type: 'double-quoted-scalar', offset, indent: indent2, source, end };
      case "'":
        return { type: 'single-quoted-scalar', offset, indent: indent2, source, end };
      default:
        return { type: 'scalar', offset, indent: indent2, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent2 = 'indent' in token ? token.indent : null;
    if (afterKey && typeof indent2 === 'number') indent2 += 2;
    if (!type)
      switch (token.type) {
        case 'single-quoted-scalar':
          type = 'QUOTE_SINGLE';
          break;
        case 'double-quoted-scalar':
          type = 'QUOTE_DOUBLE';
          break;
        case 'block-scalar': {
          const header = token.props[0];
          if (header.type !== 'block-scalar-header') throw new Error('Invalid block scalar header');
          type = header.source[0] === '>' ? 'BLOCK_FOLDED' : 'BLOCK_LITERAL';
          break;
        }
        default:
          type = 'PLAIN';
      }
    const source = stringifyString.stringifyString(
      { type, value },
      {
        implicitKey: implicitKey || indent2 === null,
        indent: indent2 !== null && indent2 > 0 ? ' '.repeat(indent2) : '',
        inFlow,
        options: { blockQuote: true, lineWidth: -1 },
      },
    );
    switch (source[0]) {
      case '|':
      case '>':
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, 'double-quoted-scalar');
        break;
      case "'":
        setFlowScalarValue(token, source, 'single-quoted-scalar');
        break;
      default:
        setFlowScalarValue(token, source, 'scalar');
    }
  }
  function setBlockScalarValue(token, source) {
    const he = source.indexOf(`
`);
    const head = source.substring(0, he);
    const body =
      source.substring(he + 1) +
      `
`;
    if (token.type === 'block-scalar') {
      const header = token.props[0];
      if (header.type !== 'block-scalar-header') throw new Error('Invalid block scalar header');
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent2 = 'indent' in token ? token.indent : -1;
      const props = [{ type: 'block-scalar-header', offset, indent: indent2, source: head }];
      if (!addEndtoBlockProps(props, 'end' in token ? token.end : undefined))
        props.push({
          type: 'newline',
          offset: -1,
          indent: indent2,
          source: `
`,
        });
      for (const key of Object.keys(token)) if (key !== 'type' && key !== 'offset') delete token[key];
      Object.assign(token, { type: 'block-scalar', indent: indent2, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case 'space':
          case 'comment':
            props.push(st);
            break;
          case 'newline':
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case 'scalar':
      case 'double-quoted-scalar':
      case 'single-quoted-scalar':
        token.type = type;
        token.source = source;
        break;
      case 'block-scalar': {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === 'block-scalar-header') oa -= token.props[0].source.length;
        for (const tok of end) tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case 'block-map':
      case 'block-seq': {
        const offset = token.offset + source.length;
        const nl = {
          type: 'newline',
          offset,
          indent: token.indent,
          source: `
`,
        };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent2 = 'indent' in token ? token.indent : -1;
        const end =
          'end' in token && Array.isArray(token.end)
            ? token.end.filter(st => st.type === 'space' || st.type === 'comment' || st.type === 'newline')
            : [];
        for (const key of Object.keys(token)) if (key !== 'type' && key !== 'offset') delete token[key];
        Object.assign(token, { type, indent: indent2, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS(exports => {
  var stringify = cst => ('type' in cst ? stringifyToken(cst) : stringifyItem(cst));
  function stringifyToken(token) {
    switch (token.type) {
      case 'block-scalar': {
        let res = '';
        for (const tok of token.props) res += stringifyToken(tok);
        return res + token.source;
      }
      case 'block-map':
      case 'block-seq': {
        let res = '';
        for (const item of token.items) res += stringifyItem(item);
        return res;
      }
      case 'flow-collection': {
        let res = token.start.source;
        for (const item of token.items) res += stringifyItem(item);
        for (const st of token.end) res += st.source;
        return res;
      }
      case 'document': {
        let res = stringifyItem(token);
        if (token.end) for (const st of token.end) res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ('end' in token && token.end) for (const st of token.end) res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep, value }) {
    let res = '';
    for (const st of start) res += st.source;
    if (key) res += stringifyToken(key);
    if (sep) for (const st of sep) res += st.source;
    if (value) res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS(exports => {
  var BREAK = Symbol('break visit');
  var SKIP = Symbol('skip children');
  var REMOVE = Symbol('remove item');
  function visit(cst, visitor) {
    if ('type' in cst && cst.type === 'document') cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path5) => {
    let item = cst;
    for (const [field, index] of path5) {
      const tok = item?.[field];
      if (tok && 'items' in tok) {
        item = tok.items[index];
      } else return;
    }
    return item;
  };
  visit.parentCollection = (cst, path5) => {
    const parent = visit.itemAtPath(cst, path5.slice(0, -1));
    const field = path5[path5.length - 1][0];
    const coll = parent?.[field];
    if (coll && 'items' in coll) return coll;
    throw new Error('Parent collection not found');
  };
  function _visit(path5, item, visitor) {
    let ctrl = visitor(item, path5);
    if (typeof ctrl === 'symbol') return ctrl;
    for (const field of ['key', 'value']) {
      const token = item[field];
      if (token && 'items' in token) {
        for (let i = 0; i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path5.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === 'number') i = ci - 1;
          else if (ci === BREAK) return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === 'function' && field === 'key') ctrl = ctrl(item, path5);
      }
    }
    return typeof ctrl === 'function' ? ctrl(item, path5) : ctrl;
  }
  exports.visit = visit;
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS(exports => {
  var cstScalar = require_cst_scalar();
  var cstStringify = require_cst_stringify();
  var cstVisit = require_cst_visit();
  var BOM = '\uFEFF';
  var DOCUMENT = '\x02';
  var FLOW_END = '\x18';
  var SCALAR = '\x1F';
  var isCollection = token => !!token && 'items' in token;
  var isScalar = token =>
    !!token &&
    (token.type === 'scalar' ||
      token.type === 'single-quoted-scalar' ||
      token.type === 'double-quoted-scalar' ||
      token.type === 'block-scalar');
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return '<BOM>';
      case DOCUMENT:
        return '<DOC>';
      case FLOW_END:
        return '<FLOW_END>';
      case SCALAR:
        return '<SCALAR>';
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return 'byte-order-mark';
      case DOCUMENT:
        return 'doc-mode';
      case FLOW_END:
        return 'flow-error-end';
      case SCALAR:
        return 'scalar';
      case '---':
        return 'doc-start';
      case '...':
        return 'doc-end';
      case '':
      case `
`:
      case `\r
`:
        return 'newline';
      case '-':
        return 'seq-item-ind';
      case '?':
        return 'explicit-key-ind';
      case ':':
        return 'map-value-ind';
      case '{':
        return 'flow-map-start';
      case '}':
        return 'flow-map-end';
      case '[':
        return 'flow-seq-start';
      case ']':
        return 'flow-seq-end';
      case ',':
        return 'comma';
    }
    switch (source[0]) {
      case ' ':
      case '\t':
        return 'space';
      case '#':
        return 'comment';
      case '%':
        return 'directive-line';
      case '*':
        return 'alias';
      case '&':
        return 'anchor';
      case '!':
        return 'tag';
      case "'":
        return 'single-quoted-scalar';
      case '"':
        return 'double-quoted-scalar';
      case '|':
      case '>':
        return 'block-scalar-header';
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS(exports => {
  var cst = require_cst();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case ' ':
      case `
`:
      case '\r':
      case '\t':
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set('0123456789ABCDEFabcdef');
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(',[]{}');
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = ch => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = '';
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== 'string') throw TypeError('source is not a string');
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? 'stream';
      while (next && (incomplete || this.hasChars(1))) next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === ' ' || ch === '\t') ch = this.buffer[++i];
      if (
        !ch ||
        ch === '#' ||
        ch ===
          `
`
      )
        return true;
      if (ch === '\r')
        return (
          this.buffer[i + 1] ===
          `
`
        );
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent2 = 0;
        while (ch === ' ') ch = this.buffer[++indent2 + offset];
        if (ch === '\r') {
          const next = this.buffer[indent2 + offset + 1];
          if (
            next ===
              `
` ||
            (!next && !this.atEnd)
          )
            return offset + indent2 + 1;
        }
        return ch ===
          `
` ||
          indent2 >= this.indentNext ||
          (!ch && !this.atEnd)
          ? offset + indent2
          : -1;
      }
      if (ch === '-' || ch === '.') {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === '---' || dt === '...') && isEmpty(this.buffer[offset + 3])) return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== 'number' || (end !== -1 && end < this.pos)) {
        end = this.buffer.indexOf(
          `
`,
          this.pos,
        );
        this.lineEndPos = end;
      }
      if (end === -1) return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === '\r') end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case 'stream':
          return yield* this.parseStream();
        case 'line-start':
          return yield* this.parseLineStart();
        case 'block-start':
          return yield* this.parseBlockStart();
        case 'doc':
          return yield* this.parseDocument();
        case 'flow':
          return yield* this.parseFlowCollection();
        case 'quoted-scalar':
          return yield* this.parseQuotedScalar();
        case 'block-scalar':
          return yield* this.parseBlockScalar();
        case 'plain-scalar':
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null) return this.setNext('stream');
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === '%') {
        let dirEnd = line.length;
        let cs = line.indexOf('#');
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === ' ' || ch === '\t') {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf('#', cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === ' ' || ch === '\t') dirEnd -= 1;
          else break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return 'stream';
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return 'stream';
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd) return this.setNext('line-start');
      if (ch === '-' || ch === '.') {
        if (!this.atEnd && !this.hasChars(4)) return this.setNext('line-start');
        const s = this.peek(3);
        if ((s === '---' || s === '...') && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === '---' ? 'doc' : 'stream';
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1))) this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd) return this.setNext('block-start');
      if ((ch0 === '-' || ch0 === '?' || ch0 === ':') && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return yield* this.parseBlockStart();
      }
      return 'doc';
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null) return this.setNext('doc');
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case '#':
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case '{':
        case '[':
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return 'flow';
        case '}':
        case ']':
          yield* this.pushCount(1);
          return 'doc';
        case '*':
          yield* this.pushUntil(isNotAnchorChar);
          return 'doc';
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case '|':
        case '>':
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent2 = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent2 = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null) return this.setNext('flow');
      if (
        (indent2 !== -1 && indent2 < this.indentNext && line[0] !== '#') ||
        (indent2 === 0 && (line.startsWith('---') || line.startsWith('...')) && isEmpty(line[3]))
      ) {
        const atFlowEndMarker =
          indent2 === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === ']' || line[0] === '}');
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ',') {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return 'flow';
        case '#':
          yield* this.pushCount(line.length - n);
          return 'flow';
        case '{':
        case '[':
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return 'flow';
        case '}':
        case ']':
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? 'flow' : 'doc';
        case '*':
          yield* this.pushUntil(isNotAnchorChar);
          return 'flow';
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ':': {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ',') {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return 'flow';
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'") end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === '\\') n += 1;
          if (n % 2 === 0) break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(
        `
`,
        this.pos,
      );
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1) break;
          nl = qb.indexOf(
            `
`,
            cs,
          );
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === '\r' ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd) return this.setNext('quoted-scalar');
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? 'flow' : 'doc';
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === '+') this.blockScalarKeep = true;
        else if (ch > '0' && ch <= '9') this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== '-') break;
      }
      return yield* this.pushUntil(ch => isEmpty(ch) || ch === '#');
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent2 = 0;
      let ch;
      loop: for (let i2 = this.pos; (ch = this.buffer[i2]); ++i2) {
        switch (ch) {
          case ' ':
            indent2 += 1;
            break;
          case `
`:
            nl = i2;
            indent2 = 0;
            break;
          case '\r': {
            const next = this.buffer[i2 + 1];
            if (!next && !this.atEnd) return this.setNext('block-scalar');
            if (
              next ===
              `
`
            )
              break;
          }
          default:
            break loop;
        }
      }
      if (!ch && !this.atEnd) return this.setNext('block-scalar');
      if (indent2 >= this.indentNext) {
        if (this.blockScalarIndent === -1) this.indentNext = indent2;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1) break;
          nl = this.buffer.indexOf(
            `
`,
            cs,
          );
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd) return this.setNext('block-scalar');
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === ' ') ch = this.buffer[++i];
      if (ch === '\t') {
        while (
          ch === '\t' ||
          ch === ' ' ||
          ch === '\r' ||
          ch ===
            `
`
        )
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i2 = nl - 1;
          let ch2 = this.buffer[i2];
          if (ch2 === '\r') ch2 = this.buffer[--i2];
          const lastChar = i2;
          while (ch2 === ' ') ch2 = this.buffer[--i2];
          if (
            ch2 ===
              `
` &&
            i2 >= this.pos &&
            i2 + 1 + indent2 > lastChar
          )
            nl = i2;
          else break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while ((ch = this.buffer[++i])) {
        if (ch === ':') {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || (inFlow && flowIndicatorChars.has(next))) break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === '\r') {
            if (
              next ===
              `
`
            ) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else end = i;
          }
          if (next === '#' || (inFlow && flowIndicatorChars.has(next))) break;
          if (
            ch ===
            `
`
          ) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1) break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch)) break;
          end = i;
        }
      }
      if (!ch && !this.atEnd) return this.setNext('plain-scalar');
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? 'flow' : 'doc';
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty) yield '';
      return 0;
    }
    *pushIndicators() {
      switch (this.charAt(0)) {
        case '!':
          return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case '&':
          return (
            (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators())
          );
        case '-':
        case '?':
        case ':': {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || (inFlow && flowIndicatorChars.has(ch1))) {
            if (!inFlow) this.indentNext = this.indentValue + 1;
            else if (this.flowKey) this.flowKey = false;
            return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          }
        }
      }
      return 0;
    }
    *pushTag() {
      if (this.charAt(1) === '<') {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== '>') ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === '>' ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch)) ch = this.buffer[++i];
          else if (ch === '%' && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[(i += 3)];
          } else break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (
        ch ===
        `
`
      )
        return yield* this.pushCount(1);
      else if (
        ch === '\r' &&
        this.charAt(1) ===
          `
`
      )
        return yield* this.pushCount(2);
      else return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === ' ' || (allowTabs && ch === '\t'));
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch)) ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS(exports => {
  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = offset => this.lineStarts.push(offset);
      this.linePos = offset => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (this.lineStarts[mid] < offset) low = mid + 1;
          else high = mid;
        }
        if (this.lineStarts[low] === offset) return { line: low + 1, col: 1 };
        if (low === 0) return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS(exports => {
  var node_process = __require('process');
  var cst = require_cst();
  var lexer = require_lexer();
  function includesToken(list, type) {
    for (let i = 0; i < list.length; ++i) if (list[i].type === type) return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0; i < list.length; ++i) {
      switch (list[i].type) {
        case 'space':
        case 'comment':
        case 'newline':
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case 'alias':
      case 'scalar':
      case 'single-quoted-scalar':
      case 'double-quoted-scalar':
      case 'flow-collection':
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case 'document':
        return parent.start;
      case 'block-map': {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case 'block-seq':
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0) return [];
    let i = prev.length;
    loop: while (--i >= 0) {
      switch (prev[i].type) {
        case 'doc-start':
        case 'explicit-key-ind':
        case 'map-value-ind':
        case 'seq-item-ind':
        case 'newline':
          break loop;
      }
    }
    while (prev[++i]?.type === 'space') {}
    return prev.splice(i, prev.length);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === 'flow-seq-start') {
      for (const it of fc.items) {
        if (
          it.sep &&
          !it.value &&
          !includesToken(it.start, 'explicit-key-ind') &&
          !includesToken(it.sep, 'map-value-ind')
        ) {
          if (it.key) it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end) Array.prototype.push.apply(it.value.end, it.sep);
            else it.value.end = it.sep;
          } else Array.prototype.push.apply(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = '';
      this.type = '';
      this.lexer = new lexer.Lexer();
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0) this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete)) yield* this.next(lexeme);
      if (!incomplete) yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS) console.log('|', cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message2 = `Not a YAML token: ${source}`;
        yield* this.pop({ type: 'error', offset: this.offset, message: message2, source });
        this.offset += source.length;
      } else if (type === 'scalar') {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = 'scalar';
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case 'newline':
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) this.onNewLine(this.offset + source.length);
            break;
          case 'space':
            if (this.atNewLine && source[0] === ' ') this.indent += source.length;
            break;
          case 'explicit-key-ind':
          case 'map-value-ind':
          case 'seq-item-ind':
            if (this.atNewLine) this.indent += source.length;
            break;
          case 'doc-mode':
          case 'flow-error-end':
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0) yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source,
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === 'doc-end' && top?.type !== 'doc-end') {
        while (this.stack.length > 0) yield* this.pop();
        this.stack.push({
          type: 'doc-end',
          offset: this.offset,
          source: this.source,
        });
        return;
      }
      if (!top) return yield* this.stream();
      switch (top.type) {
        case 'document':
          return yield* this.document(top);
        case 'alias':
        case 'scalar':
        case 'single-quoted-scalar':
        case 'double-quoted-scalar':
          return yield* this.scalar(top);
        case 'block-scalar':
          return yield* this.blockScalar(top);
        case 'block-map':
          return yield* this.blockMap(top);
        case 'block-seq':
          return yield* this.blockSequence(top);
        case 'flow-collection':
          return yield* this.flowCollection(top);
        case 'doc-end':
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message2 = 'Tried to pop an empty stack';
        yield { type: 'error', offset: this.offset, source: '', message: message2 };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === 'block-scalar') {
          token.indent = 'indent' in top ? top.indent : 0;
        } else if (token.type === 'flow-collection' && top.type === 'document') {
          token.indent = 0;
        }
        if (token.type === 'flow-collection') fixFlowSeqItems(token);
        switch (top.type) {
          case 'document':
            top.value = token;
            break;
          case 'block-scalar':
            top.props.push(token);
            break;
          case 'block-map': {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case 'block-seq': {
            const it = top.items[top.items.length - 1];
            if (it.value) top.items.push({ start: [], value: token });
            else it.value = token;
            break;
          }
          case 'flow-collection': {
            const it = top.items[top.items.length - 1];
            if (!it || it.value) top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep) it.value = token;
            else Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if (
          (top.type === 'document' || top.type === 'block-map' || top.type === 'block-seq') &&
          (token.type === 'block-map' || token.type === 'block-seq')
        ) {
          const last = token.items[token.items.length - 1];
          if (
            last &&
            !last.sep &&
            !last.value &&
            last.start.length > 0 &&
            findNonEmptyIndex(last.start) === -1 &&
            (token.indent === 0 || last.start.every(st => st.type !== 'comment' || st.indent < token.indent))
          ) {
            if (top.type === 'document') top.end = last.start;
            else top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case 'directive-line':
          yield { type: 'directive', offset: this.offset, source: this.source };
          return;
        case 'byte-order-mark':
        case 'space':
        case 'comment':
        case 'newline':
          yield this.sourceToken;
          return;
        case 'doc-mode':
        case 'doc-start': {
          const doc = {
            type: 'document',
            offset: this.offset,
            start: [],
          };
          if (this.type === 'doc-start') doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: 'error',
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source,
      };
    }
    *document(doc) {
      if (doc.value) return yield* this.lineEnd(doc);
      switch (this.type) {
        case 'doc-start': {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else doc.start.push(this.sourceToken);
          return;
        }
        case 'anchor':
        case 'tag':
        case 'space':
        case 'comment':
        case 'newline':
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv) this.stack.push(bv);
      else {
        yield {
          type: 'error',
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source,
        };
      }
    }
    *scalar(scalar) {
      if (this.type === 'map-value-ind') {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep;
        if (scalar.end) {
          sep = scalar.end;
          sep.push(this.sourceToken);
          delete scalar.end;
        } else sep = [this.sourceToken];
        const map = {
          type: 'block-map',
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep }],
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case 'space':
        case 'comment':
        case 'newline':
          scalar.props.push(this.sourceToken);
          return;
        case 'scalar':
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl =
              this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl =
                this.source.indexOf(
                  `
`,
                  nl,
                ) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case 'newline':
          this.onKeyLine = false;
          if (it.value) {
            const end = 'end' in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === 'comment') end?.push(this.sourceToken);
            else map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case 'space':
        case 'comment':
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== 'seq-item-ind';
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0; i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case 'newline':
                nl.push(i);
                break;
              case 'space':
                break;
              case 'comment':
                if (st.indent > map.indent) nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2) start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case 'anchor':
          case 'tag':
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case 'explicit-key-ind':
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: 'block-map',
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }],
              });
            }
            this.onKeyLine = true;
            return;
          case 'map-value-ind':
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, 'newline')) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start2 = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: 'block-map',
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }],
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, 'map-value-ind')) {
                this.stack.push({
                  type: 'block-map',
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }],
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, 'newline')) {
                const start2 = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep = it.sep;
                sep.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: 'block-map',
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep }],
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, 'map-value-ind')) {
                this.stack.push({
                  type: 'block-map',
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }],
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case 'alias':
          case 'scalar':
          case 'single-quoted-scalar':
          case 'double-quoted-scalar': {
            const fs5 = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs5, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs5);
            } else {
              Object.assign(it, { key: fs5, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === 'block-seq') {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, 'newline')) {
                  yield* this.pop({
                    type: 'error',
                    offset: this.offset,
                    message: 'Unexpected block-seq-ind on same line with key',
                    source: this.source,
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case 'newline':
          if (it.value) {
            const end = 'end' in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === 'comment') end?.push(this.sourceToken);
            else seq.items.push({ start: [this.sourceToken] });
          } else it.start.push(this.sourceToken);
          return;
        case 'space':
        case 'comment':
          if (it.value) seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case 'anchor':
        case 'tag':
          if (it.value || this.indent <= seq.indent) break;
          it.start.push(this.sourceToken);
          return;
        case 'seq-item-ind':
          if (this.indent !== seq.indent) break;
          if (it.value || includesToken(it.start, 'seq-item-ind')) seq.items.push({ start: [this.sourceToken] });
          else it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === 'flow-error-end') {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === 'flow-collection');
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case 'comma':
          case 'explicit-key-ind':
            if (!it || it.sep) fc.items.push({ start: [this.sourceToken] });
            else it.start.push(this.sourceToken);
            return;
          case 'map-value-ind':
            if (!it || it.value) fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep) it.sep.push(this.sourceToken);
            else Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case 'space':
          case 'comment':
          case 'newline':
          case 'anchor':
          case 'tag':
            if (!it || it.value) fc.items.push({ start: [this.sourceToken] });
            else if (it.sep) it.sep.push(this.sourceToken);
            else it.start.push(this.sourceToken);
            return;
          case 'alias':
          case 'scalar':
          case 'single-quoted-scalar':
          case 'double-quoted-scalar': {
            const fs5 = this.flowScalar(this.type);
            if (!it || it.value) fc.items.push({ start: [], key: fs5, sep: [] });
            else if (it.sep) this.stack.push(fs5);
            else Object.assign(it, { key: fs5, sep: [] });
            return;
          }
          case 'flow-map-end':
          case 'flow-seq-end':
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv) this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (
          parent.type === 'block-map' &&
          ((this.type === 'map-value-ind' && parent.indent === fc.indent) ||
            (this.type === 'newline' && !parent.items[parent.items.length - 1].sep))
        ) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === 'map-value-ind' && parent.type !== 'flow-collection') {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep = fc.end.splice(1, fc.end.length);
          sep.push(this.sourceToken);
          const map = {
            type: 'block-map',
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep }],
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl =
          this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl =
            this.source.indexOf(
              `
`,
              nl,
            ) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source,
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case 'alias':
        case 'scalar':
        case 'single-quoted-scalar':
        case 'double-quoted-scalar':
          return this.flowScalar(this.type);
        case 'block-scalar-header':
          return {
            type: 'block-scalar',
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: '',
          };
        case 'flow-map-start':
        case 'flow-seq-start':
          return {
            type: 'flow-collection',
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: [],
          };
        case 'seq-item-ind':
          return {
            type: 'block-seq',
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }],
          };
        case 'explicit-key-ind': {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: 'block-map',
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }],
          };
        }
        case 'map-value-ind': {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: 'block-map',
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }],
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent2) {
      if (this.type !== 'comment') return false;
      if (this.indent <= indent2) return false;
      return start.every(st => st.type === 'newline' || st.type === 'space');
    }
    *documentEnd(docEnd) {
      if (this.type !== 'doc-mode') {
        if (docEnd.end) docEnd.end.push(this.sourceToken);
        else docEnd.end = [this.sourceToken];
        if (this.type === 'newline') yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case 'comma':
        case 'doc-start':
        case 'doc-end':
        case 'flow-seq-end':
        case 'flow-map-end':
        case 'map-value-ind':
          yield* this.pop();
          yield* this.step();
          break;
        case 'newline':
          this.onKeyLine = false;
        case 'space':
        case 'comment':
        default:
          if (token.end) token.end.push(this.sourceToken);
          else token.end = [this.sourceToken];
          if (this.type === 'newline') yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS(exports => {
  var composer = require_composer();
  var Document = require_Document();
  var errors2 = require_errors();
  var log = require_log();
  var identity = require_identity();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || (prettyErrors && new lineCounter.LineCounter()) || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter2)
      for (const doc of docs) {
        doc.errors.forEach(errors2.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors2.prettifyError(source, lineCounter2));
      }
    if (docs.length > 0) return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc) doc = _doc;
      else if (doc.options.logLevel !== 'silent') {
        doc.errors.push(
          new errors2.YAMLParseError(
            _doc.range.slice(0, 2),
            'MULTIPLE_DOCS',
            'Source contains multiple documents; please use YAML.parseAllDocuments()',
          ),
        );
        break;
      }
    }
    if (prettyErrors && lineCounter2) {
      doc.errors.forEach(errors2.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors2.prettifyError(source, lineCounter2));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === 'function') {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === 'object') {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc) return null;
    doc.warnings.forEach(warning => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== 'silent') throw doc.errors[0];
      else doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === 'function' || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === 'string') options = options.length;
    if (typeof options === 'number') {
      const indent2 = Math.round(options);
      options = indent2 < 1 ? undefined : indent2 > 8 ? { indent: 8 } : { indent: indent2 };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined) return;
    }
    if (identity.isDocument(value) && !_replacer) return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS(exports => {
  var composer = require_composer();
  var Document = require_Document();
  var Schema = require_Schema();
  var errors2 = require_errors();
  var Alias = require_Alias();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var cst = require_cst();
  var lexer = require_lexer();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  var publicApi = require_public_api();
  var visit = require_visit();
  exports.Composer = composer.Composer;
  exports.Document = Document.Document;
  exports.Schema = Schema.Schema;
  exports.YAMLError = errors2.YAMLError;
  exports.YAMLParseError = errors2.YAMLParseError;
  exports.YAMLWarning = errors2.YAMLWarning;
  exports.Alias = Alias.Alias;
  exports.isAlias = identity.isAlias;
  exports.isCollection = identity.isCollection;
  exports.isDocument = identity.isDocument;
  exports.isMap = identity.isMap;
  exports.isNode = identity.isNode;
  exports.isPair = identity.isPair;
  exports.isScalar = identity.isScalar;
  exports.isSeq = identity.isSeq;
  exports.Pair = Pair.Pair;
  exports.Scalar = Scalar.Scalar;
  exports.YAMLMap = YAMLMap.YAMLMap;
  exports.YAMLSeq = YAMLSeq.YAMLSeq;
  exports.CST = cst;
  exports.Lexer = lexer.Lexer;
  exports.LineCounter = lineCounter.LineCounter;
  exports.Parser = parser.Parser;
  exports.parse = publicApi.parse;
  exports.parseAllDocuments = publicApi.parseAllDocuments;
  exports.parseDocument = publicApi.parseDocument;
  exports.stringify = publicApi.stringify;
  exports.visit = visit.visit;
  exports.visitAsync = visit.visitAsync;
});

// node_modules/cli-table3/src/debug.js
var require_debug = __commonJS((exports, module) => {
  var messages = [];
  var level = 0;
  var debug = (msg, min) => {
    if (level >= min) {
      messages.push(msg);
    }
  };
  debug.WARN = 1;
  debug.INFO = 2;
  debug.DEBUG = 3;
  debug.reset = () => {
    messages = [];
  };
  debug.setDebugLevel = v => {
    level = v;
  };
  debug.warn = msg => debug(msg, debug.WARN);
  debug.info = msg => debug(msg, debug.INFO);
  debug.debug = msg => debug(msg, debug.DEBUG);
  debug.debugMessages = () => messages;
  module.exports = debug;
});

// node_modules/ansi-regex/index.js
var require_ansi_regex = __commonJS((exports, module) => {
  module.exports = ({ onlyFirst = false } = {}) => {
    const pattern = [
      '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
      '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
    ].join('|');
    return new RegExp(pattern, onlyFirst ? undefined : 'g');
  };
});

// node_modules/strip-ansi/index.js
var require_strip_ansi = __commonJS((exports, module) => {
  var ansiRegex = require_ansi_regex();
  module.exports = string => (typeof string === 'string' ? string.replace(ansiRegex(), '') : string);
});

// node_modules/is-fullwidth-code-point/index.js
var require_is_fullwidth_code_point = __commonJS((exports, module) => {
  var isFullwidthCodePoint = codePoint => {
    if (Number.isNaN(codePoint)) {
      return false;
    }
    if (
      codePoint >= 4352 &&
      (codePoint <= 4447 ||
        codePoint === 9001 ||
        codePoint === 9002 ||
        (11904 <= codePoint && codePoint <= 12871 && codePoint !== 12351) ||
        (12880 <= codePoint && codePoint <= 19903) ||
        (19968 <= codePoint && codePoint <= 42182) ||
        (43360 <= codePoint && codePoint <= 43388) ||
        (44032 <= codePoint && codePoint <= 55203) ||
        (63744 <= codePoint && codePoint <= 64255) ||
        (65040 <= codePoint && codePoint <= 65049) ||
        (65072 <= codePoint && codePoint <= 65131) ||
        (65281 <= codePoint && codePoint <= 65376) ||
        (65504 <= codePoint && codePoint <= 65510) ||
        (110592 <= codePoint && codePoint <= 110593) ||
        (127488 <= codePoint && codePoint <= 127569) ||
        (131072 <= codePoint && codePoint <= 262141))
    ) {
      return true;
    }
    return false;
  };
  module.exports = isFullwidthCodePoint;
  module.exports.default = isFullwidthCodePoint;
});

// node_modules/emoji-regex/index.js
var require_emoji_regex = __commonJS((exports, module) => {
  module.exports = function () {
    return /\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F|\uD83D\uDC68(?:\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68\uD83C\uDFFB|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFE])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83D\uDC68|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D[\uDC66\uDC67])|[\u2695\u2696\u2708]\uFE0F|\uD83D[\uDC66\uDC67]|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|(?:\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708])\uFE0F|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C[\uDFFB-\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFB\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)\uD83C\uDFFB|\uD83E\uDDD1(?:\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])|\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1)|(?:\uD83E\uDDD1\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFE])|(?:\uD83E\uDDD1\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)(?:\uD83C[\uDFFB\uDFFC])|\uD83D\uDC69(?:\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFC-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|(?:\uD83E\uDDD1\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)(?:\uD83C[\uDFFB-\uDFFD])|\uD83D\uDC69\u200D\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D\uDC41\uFE0F\u200D\uD83D\uDDE8|\uD83D\uDC69(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|(?:(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)\uFE0F|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF])\u200D[\u2640\u2642]|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD6-\uDDDD])(?:(?:\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|\u200D[\u2640\u2642])|\uD83C\uDFF4\u200D\u2620)\uFE0F|\uD83D\uDC69\u200D\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08|\uD83D\uDC15\u200D\uD83E\uDDBA|\uD83D\uDC69\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC67|\uD83C\uDDFD\uD83C\uDDF0|\uD83C\uDDF4\uD83C\uDDF2|\uD83C\uDDF6\uD83C\uDDE6|[#\*0-9]\uFE0F\u20E3|\uD83C\uDDE7(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF])|\uD83C\uDDF9(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF])|\uD83C\uDDEA(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA])|\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])|\uD83C\uDDF7(?:\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC])|\uD83D\uDC69(?:\uD83C[\uDFFB-\uDFFF])|\uD83C\uDDF2(?:\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF])|\uD83C\uDDE6(?:\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF])|\uD83C\uDDF0(?:\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF])|\uD83C\uDDED(?:\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA])|\uD83C\uDDE9(?:\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF])|\uD83C\uDDFE(?:\uD83C[\uDDEA\uDDF9])|\uD83C\uDDEC(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE])|\uD83C\uDDF8(?:\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF])|\uD83C\uDDEB(?:\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7])|\uD83C\uDDF5(?:\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE])|\uD83C\uDDFB(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA])|\uD83C\uDDF3(?:\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF])|\uD83C\uDDE8(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF])|\uD83C\uDDF1(?:\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE])|\uD83C\uDDFF(?:\uD83C[\uDDE6\uDDF2\uDDFC])|\uD83C\uDDFC(?:\uD83C[\uDDEB\uDDF8])|\uD83C\uDDFA(?:\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF])|\uD83C\uDDEE(?:\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9])|\uD83C\uDDEF(?:\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5])|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u261D\u270A-\u270D]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC70\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDCAA\uDD74\uDD7A\uDD90\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD36\uDDB5\uDDB6\uDDBB\uDDD2-\uDDD5])(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDED5\uDEEB\uDEEC\uDEF4-\uDEFA\uDFE0-\uDFEB]|\uD83E[\uDD0D-\uDD3A\uDD3C-\uDD45\uDD47-\uDD71\uDD73-\uDD76\uDD7A-\uDDA2\uDDA5-\uDDAA\uDDAE-\uDDCA\uDDCD-\uDDFF\uDE70-\uDE73\uDE78-\uDE7A\uDE80-\uDE82\uDE90-\uDE95])|(?:[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]|\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEFA\uDFE0-\uDFEB]|\uD83E[\uDD0D-\uDD3A\uDD3C-\uDD45\uDD47-\uDD71\uDD73-\uDD76\uDD7A-\uDDA2\uDDA5-\uDDAA\uDDAE-\uDDCA\uDDCD-\uDDFF\uDE70-\uDE73\uDE78-\uDE7A\uDE80-\uDE82\uDE90-\uDE95])\uFE0F|(?:[\u261D\u26F9\u270A-\u270D]|\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDC8F\uDC91\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD0F\uDD18-\uDD1F\uDD26\uDD30-\uDD39\uDD3C-\uDD3E\uDDB5\uDDB6\uDDB8\uDDB9\uDDBB\uDDCD-\uDDCF\uDDD1-\uDDDD])/g;
  };
});

// node_modules/string-width/index.js
var require_string_width = __commonJS((exports, module) => {
  var stripAnsi = require_strip_ansi();
  var isFullwidthCodePoint = require_is_fullwidth_code_point();
  var emojiRegex2 = require_emoji_regex();
  var stringWidth = string => {
    if (typeof string !== 'string' || string.length === 0) {
      return 0;
    }
    string = stripAnsi(string);
    if (string.length === 0) {
      return 0;
    }
    string = string.replace(emojiRegex2(), '  ');
    let width = 0;
    for (let i = 0; i < string.length; i++) {
      const code = string.codePointAt(i);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        continue;
      }
      if (code >= 768 && code <= 879) {
        continue;
      }
      if (code > 65535) {
        i++;
      }
      width += isFullwidthCodePoint(code) ? 2 : 1;
    }
    return width;
  };
  module.exports = stringWidth;
  module.exports.default = stringWidth;
});

// node_modules/cli-table3/src/utils.js
var require_utils = __commonJS((exports, module) => {
  var stringWidth = require_string_width();
  function codeRegex(capture) {
    return capture ? /\u001b\[((?:\d*;){0,5}\d*)m/g : /\u001b\[(?:\d*;){0,5}\d*m/g;
  }
  function strlen(str) {
    let code = codeRegex();
    let stripped = ('' + str).replace(code, '');
    let split = stripped.split(`
`);
    return split.reduce(function (memo, s) {
      return stringWidth(s) > memo ? stringWidth(s) : memo;
    }, 0);
  }
  function repeat(str, times) {
    return Array(times + 1).join(str);
  }
  function pad(str, len, pad2, dir) {
    let length = strlen(str);
    if (len + 1 >= length) {
      let padlen = len - length;
      switch (dir) {
        case 'right': {
          str = repeat(pad2, padlen) + str;
          break;
        }
        case 'center': {
          let right = Math.ceil(padlen / 2);
          let left = padlen - right;
          str = repeat(pad2, left) + str + repeat(pad2, right);
          break;
        }
        default: {
          str = str + repeat(pad2, padlen);
          break;
        }
      }
    }
    return str;
  }
  var codeCache = {};
  function addToCodeCache(name, on, off) {
    on = '\x1B[' + on + 'm';
    off = '\x1B[' + off + 'm';
    codeCache[on] = { set: name, to: true };
    codeCache[off] = { set: name, to: false };
    codeCache[name] = { on, off };
  }
  addToCodeCache('bold', 1, 22);
  addToCodeCache('italics', 3, 23);
  addToCodeCache('underline', 4, 24);
  addToCodeCache('inverse', 7, 27);
  addToCodeCache('strikethrough', 9, 29);
  function updateState(state, controlChars) {
    let controlCode = controlChars[1] ? parseInt(controlChars[1].split(';')[0]) : 0;
    if ((controlCode >= 30 && controlCode <= 39) || (controlCode >= 90 && controlCode <= 97)) {
      state.lastForegroundAdded = controlChars[0];
      return;
    }
    if ((controlCode >= 40 && controlCode <= 49) || (controlCode >= 100 && controlCode <= 107)) {
      state.lastBackgroundAdded = controlChars[0];
      return;
    }
    if (controlCode === 0) {
      for (let i in state) {
        if (Object.prototype.hasOwnProperty.call(state, i)) {
          delete state[i];
        }
      }
      return;
    }
    let info = codeCache[controlChars[0]];
    if (info) {
      state[info.set] = info.to;
    }
  }
  function readState(line) {
    let code = codeRegex(true);
    let controlChars = code.exec(line);
    let state = {};
    while (controlChars !== null) {
      updateState(state, controlChars);
      controlChars = code.exec(line);
    }
    return state;
  }
  function unwindState(state, ret) {
    let lastBackgroundAdded = state.lastBackgroundAdded;
    let lastForegroundAdded = state.lastForegroundAdded;
    delete state.lastBackgroundAdded;
    delete state.lastForegroundAdded;
    Object.keys(state).forEach(function (key) {
      if (state[key]) {
        ret += codeCache[key].off;
      }
    });
    if (lastBackgroundAdded && lastBackgroundAdded != '\x1B[49m') {
      ret += '\x1B[49m';
    }
    if (lastForegroundAdded && lastForegroundAdded != '\x1B[39m') {
      ret += '\x1B[39m';
    }
    return ret;
  }
  function rewindState(state, ret) {
    let lastBackgroundAdded = state.lastBackgroundAdded;
    let lastForegroundAdded = state.lastForegroundAdded;
    delete state.lastBackgroundAdded;
    delete state.lastForegroundAdded;
    Object.keys(state).forEach(function (key) {
      if (state[key]) {
        ret = codeCache[key].on + ret;
      }
    });
    if (lastBackgroundAdded && lastBackgroundAdded != '\x1B[49m') {
      ret = lastBackgroundAdded + ret;
    }
    if (lastForegroundAdded && lastForegroundAdded != '\x1B[39m') {
      ret = lastForegroundAdded + ret;
    }
    return ret;
  }
  function truncateWidth(str, desiredLength) {
    if (str.length === strlen(str)) {
      return str.substr(0, desiredLength);
    }
    while (strlen(str) > desiredLength) {
      str = str.slice(0, -1);
    }
    return str;
  }
  function truncateWidthWithAnsi(str, desiredLength) {
    let code = codeRegex(true);
    let split = str.split(codeRegex());
    let splitIndex = 0;
    let retLen = 0;
    let ret = '';
    let myArray;
    let state = {};
    while (retLen < desiredLength) {
      myArray = code.exec(str);
      let toAdd = split[splitIndex];
      splitIndex++;
      if (retLen + strlen(toAdd) > desiredLength) {
        toAdd = truncateWidth(toAdd, desiredLength - retLen);
      }
      ret += toAdd;
      retLen += strlen(toAdd);
      if (retLen < desiredLength) {
        if (!myArray) {
          break;
        }
        ret += myArray[0];
        updateState(state, myArray);
      }
    }
    return unwindState(state, ret);
  }
  function truncate(str, desiredLength, truncateChar) {
    truncateChar = truncateChar || '\u2026';
    let lengthOfStr = strlen(str);
    if (lengthOfStr <= desiredLength) {
      return str;
    }
    desiredLength -= strlen(truncateChar);
    let ret = truncateWidthWithAnsi(str, desiredLength);
    ret += truncateChar;
    const hrefTag = '\x1B]8;;\x07';
    if (str.includes(hrefTag) && !ret.includes(hrefTag)) {
      ret += hrefTag;
    }
    return ret;
  }
  function defaultOptions2() {
    return {
      chars: {
        top: '\u2500',
        'top-mid': '\u252C',
        'top-left': '\u250C',
        'top-right': '\u2510',
        bottom: '\u2500',
        'bottom-mid': '\u2534',
        'bottom-left': '\u2514',
        'bottom-right': '\u2518',
        left: '\u2502',
        'left-mid': '\u251C',
        mid: '\u2500',
        'mid-mid': '\u253C',
        right: '\u2502',
        'right-mid': '\u2524',
        middle: '\u2502',
      },
      truncate: '\u2026',
      colWidths: [],
      rowHeights: [],
      colAligns: [],
      rowAligns: [],
      style: {
        'padding-left': 1,
        'padding-right': 1,
        head: ['red'],
        border: ['grey'],
        compact: false,
      },
      head: [],
    };
  }
  function mergeOptions(options, defaults) {
    options = options || {};
    defaults = defaults || defaultOptions2();
    let ret = Object.assign({}, defaults, options);
    ret.chars = Object.assign({}, defaults.chars, options.chars);
    ret.style = Object.assign({}, defaults.style, options.style);
    return ret;
  }
  function wordWrap(maxLength, input) {
    let lines = [];
    let split = input.split(/(\s+)/g);
    let line = [];
    let lineLength = 0;
    let whitespace;
    for (let i = 0; i < split.length; i += 2) {
      let word = split[i];
      let newLength = lineLength + strlen(word);
      if (lineLength > 0 && whitespace) {
        newLength += whitespace.length;
      }
      if (newLength > maxLength) {
        if (lineLength !== 0) {
          lines.push(line.join(''));
        }
        line = [word];
        lineLength = strlen(word);
      } else {
        line.push(whitespace || '', word);
        lineLength = newLength;
      }
      whitespace = split[i + 1];
    }
    if (lineLength) {
      lines.push(line.join(''));
    }
    return lines;
  }
  function textWrap(maxLength, input) {
    let lines = [];
    let line = '';
    function pushLine(str, ws) {
      if (line.length && ws) line += ws;
      line += str;
      while (line.length > maxLength) {
        lines.push(line.slice(0, maxLength));
        line = line.slice(maxLength);
      }
    }
    let split = input.split(/(\s+)/g);
    for (let i = 0; i < split.length; i += 2) {
      pushLine(split[i], i && split[i - 1]);
    }
    if (line.length) lines.push(line);
    return lines;
  }
  function multiLineWordWrap(maxLength, input, wrapOnWordBoundary = true) {
    let output = [];
    input = input.split(`
`);
    const handler4 = wrapOnWordBoundary ? wordWrap : textWrap;
    for (let i = 0; i < input.length; i++) {
      output.push.apply(output, handler4(maxLength, input[i]));
    }
    return output;
  }
  function colorizeLines(input) {
    let state = {};
    let output = [];
    for (let i = 0; i < input.length; i++) {
      let line = rewindState(state, input[i]);
      state = readState(line);
      let temp = Object.assign({}, state);
      output.push(unwindState(temp, line));
    }
    return output;
  }
  function hyperlink(url, text) {
    const OSC = '\x1B]';
    const BEL = '\x07';
    const SEP = ';';
    return [OSC, '8', SEP, SEP, url || text, BEL, text, OSC, '8', SEP, SEP, BEL].join('');
  }
  module.exports = {
    strlen,
    repeat,
    pad,
    truncate,
    mergeOptions,
    wordWrap: multiLineWordWrap,
    colorizeLines,
    hyperlink,
  };
});

// node_modules/@colors/colors/lib/styles.js
var require_styles = __commonJS((exports, module) => {
  var styles = {};
  module['exports'] = styles;
  var codes = {
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    gray: [90, 39],
    grey: [90, 39],
    brightRed: [91, 39],
    brightGreen: [92, 39],
    brightYellow: [93, 39],
    brightBlue: [94, 39],
    brightMagenta: [95, 39],
    brightCyan: [96, 39],
    brightWhite: [97, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    bgGray: [100, 49],
    bgGrey: [100, 49],
    bgBrightRed: [101, 49],
    bgBrightGreen: [102, 49],
    bgBrightYellow: [103, 49],
    bgBrightBlue: [104, 49],
    bgBrightMagenta: [105, 49],
    bgBrightCyan: [106, 49],
    bgBrightWhite: [107, 49],
    blackBG: [40, 49],
    redBG: [41, 49],
    greenBG: [42, 49],
    yellowBG: [43, 49],
    blueBG: [44, 49],
    magentaBG: [45, 49],
    cyanBG: [46, 49],
    whiteBG: [47, 49],
  };
  Object.keys(codes).forEach(function (key) {
    var val = codes[key];
    var style = (styles[key] = []);
    style.open = '\x1B[' + val[0] + 'm';
    style.close = '\x1B[' + val[1] + 'm';
  });
});

// node_modules/@colors/colors/lib/system/has-flag.js
var require_has_flag = __commonJS((exports, module) => {
  module.exports = function (flag, argv) {
    argv = argv || process.argv;
    var terminatorPos = argv.indexOf('--');
    var prefix = /^-{1,2}/.test(flag) ? '' : '--';
    var pos = argv.indexOf(prefix + flag);
    return pos !== -1 && (terminatorPos === -1 ? true : pos < terminatorPos);
  };
});

// node_modules/@colors/colors/lib/system/supports-colors.js
var require_supports_colors = __commonJS((exports, module) => {
  var os2 = __require('os');
  var hasFlag = require_has_flag();
  var env = process.env;
  var forceColor = undefined;
  if (hasFlag('no-color') || hasFlag('no-colors') || hasFlag('color=false')) {
    forceColor = false;
  } else if (hasFlag('color') || hasFlag('colors') || hasFlag('color=true') || hasFlag('color=always')) {
    forceColor = true;
  }
  if ('FORCE_COLOR' in env) {
    forceColor = env.FORCE_COLOR.length === 0 || parseInt(env.FORCE_COLOR, 10) !== 0;
  }
  function translateLevel(level) {
    if (level === 0) {
      return false;
    }
    return {
      level,
      hasBasic: true,
      has256: level >= 2,
      has16m: level >= 3,
    };
  }
  function supportsColor(stream) {
    if (forceColor === false) {
      return 0;
    }
    if (hasFlag('color=16m') || hasFlag('color=full') || hasFlag('color=truecolor')) {
      return 3;
    }
    if (hasFlag('color=256')) {
      return 2;
    }
    if (stream && !stream.isTTY && forceColor !== true) {
      return 0;
    }
    var min = forceColor ? 1 : 0;
    if (process.platform === 'win32') {
      var osRelease = os2.release().split('.');
      if (
        Number(process.versions.node.split('.')[0]) >= 8 &&
        Number(osRelease[0]) >= 10 &&
        Number(osRelease[2]) >= 10586
      ) {
        return Number(osRelease[2]) >= 14931 ? 3 : 2;
      }
      return 1;
    }
    if ('CI' in env) {
      if (
        ['TRAVIS', 'CIRCLECI', 'APPVEYOR', 'GITLAB_CI'].some(function (sign) {
          return sign in env;
        }) ||
        env.CI_NAME === 'codeship'
      ) {
        return 1;
      }
      return min;
    }
    if ('TEAMCITY_VERSION' in env) {
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
    }
    if ('TERM_PROGRAM' in env) {
      var version = parseInt((env.TERM_PROGRAM_VERSION || '').split('.')[0], 10);
      switch (env.TERM_PROGRAM) {
        case 'iTerm.app':
          return version >= 3 ? 3 : 2;
        case 'Hyper':
          return 3;
        case 'Apple_Terminal':
          return 2;
      }
    }
    if (/-256(color)?$/i.test(env.TERM)) {
      return 2;
    }
    if (/^screen|^xterm|^vt100|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
      return 1;
    }
    if ('COLORTERM' in env) {
      return 1;
    }
    if (env.TERM === 'dumb') {
      return min;
    }
    return min;
  }
  function getSupportLevel(stream) {
    var level = supportsColor(stream);
    return translateLevel(level);
  }
  module.exports = {
    supportsColor: getSupportLevel,
    stdout: getSupportLevel(process.stdout),
    stderr: getSupportLevel(process.stderr),
  };
});

// node_modules/@colors/colors/lib/custom/trap.js
var require_trap = __commonJS((exports, module) => {
  module['exports'] = function runTheTrap(text, options) {
    var result = '';
    text = text || 'Run the trap, drop the bass';
    text = text.split('');
    var trap = {
      a: ['@', '\u0104', '\u023A', '\u0245', '\u0394', '\u039B', '\u0414'],
      b: ['\xDF', '\u0181', '\u0243', '\u026E', '\u03B2', '\u0E3F'],
      c: ['\xA9', '\u023B', '\u03FE'],
      d: ['\xD0', '\u018A', '\u0500', '\u0501', '\u0502', '\u0503'],
      e: ['\xCB', '\u0115', '\u018E', '\u0258', '\u03A3', '\u03BE', '\u04BC', '\u0A6C'],
      f: ['\u04FA'],
      g: ['\u0262'],
      h: ['\u0126', '\u0195', '\u04A2', '\u04BA', '\u04C7', '\u050A'],
      i: ['\u0F0F'],
      j: ['\u0134'],
      k: ['\u0138', '\u04A0', '\u04C3', '\u051E'],
      l: ['\u0139'],
      m: ['\u028D', '\u04CD', '\u04CE', '\u0520', '\u0521', '\u0D69'],
      n: ['\xD1', '\u014B', '\u019D', '\u0376', '\u03A0', '\u048A'],
      o: ['\xD8', '\xF5', '\xF8', '\u01FE', '\u0298', '\u047A', '\u05DD', '\u06DD', '\u0E4F'],
      p: ['\u01F7', '\u048E'],
      q: ['\u09CD'],
      r: ['\xAE', '\u01A6', '\u0210', '\u024C', '\u0280', '\u042F'],
      s: ['\xA7', '\u03DE', '\u03DF', '\u03E8'],
      t: ['\u0141', '\u0166', '\u0373'],
      u: ['\u01B1', '\u054D'],
      v: ['\u05D8'],
      w: ['\u0428', '\u0460', '\u047C', '\u0D70'],
      x: ['\u04B2', '\u04FE', '\u04FC', '\u04FD'],
      y: ['\xA5', '\u04B0', '\u04CB'],
      z: ['\u01B5', '\u0240'],
    };
    text.forEach(function (c) {
      c = c.toLowerCase();
      var chars = trap[c] || [' '];
      var rand = Math.floor(Math.random() * chars.length);
      if (typeof trap[c] !== 'undefined') {
        result += trap[c][rand];
      } else {
        result += c;
      }
    });
    return result;
  };
});

// node_modules/@colors/colors/lib/custom/zalgo.js
var require_zalgo = __commonJS((exports, module) => {
  module['exports'] = function zalgo(text, options) {
    text = text || '   he is here   ';
    var soul = {
      up: [
        '\u030D',
        '\u030E',
        '\u0304',
        '\u0305',
        '\u033F',
        '\u0311',
        '\u0306',
        '\u0310',
        '\u0352',
        '\u0357',
        '\u0351',
        '\u0307',
        '\u0308',
        '\u030A',
        '\u0342',
        '\u0313',
        '\u0308',
        '\u034A',
        '\u034B',
        '\u034C',
        '\u0303',
        '\u0302',
        '\u030C',
        '\u0350',
        '\u0300',
        '\u0301',
        '\u030B',
        '\u030F',
        '\u0312',
        '\u0313',
        '\u0314',
        '\u033D',
        '\u0309',
        '\u0363',
        '\u0364',
        '\u0365',
        '\u0366',
        '\u0367',
        '\u0368',
        '\u0369',
        '\u036A',
        '\u036B',
        '\u036C',
        '\u036D',
        '\u036E',
        '\u036F',
        '\u033E',
        '\u035B',
        '\u0346',
        '\u031A',
      ],
      down: [
        '\u0316',
        '\u0317',
        '\u0318',
        '\u0319',
        '\u031C',
        '\u031D',
        '\u031E',
        '\u031F',
        '\u0320',
        '\u0324',
        '\u0325',
        '\u0326',
        '\u0329',
        '\u032A',
        '\u032B',
        '\u032C',
        '\u032D',
        '\u032E',
        '\u032F',
        '\u0330',
        '\u0331',
        '\u0332',
        '\u0333',
        '\u0339',
        '\u033A',
        '\u033B',
        '\u033C',
        '\u0345',
        '\u0347',
        '\u0348',
        '\u0349',
        '\u034D',
        '\u034E',
        '\u0353',
        '\u0354',
        '\u0355',
        '\u0356',
        '\u0359',
        '\u035A',
        '\u0323',
      ],
      mid: [
        '\u0315',
        '\u031B',
        '\u0300',
        '\u0301',
        '\u0358',
        '\u0321',
        '\u0322',
        '\u0327',
        '\u0328',
        '\u0334',
        '\u0335',
        '\u0336',
        '\u035C',
        '\u035D',
        '\u035E',
        '\u035F',
        '\u0360',
        '\u0362',
        '\u0338',
        '\u0337',
        '\u0361',
        ' \u0489',
      ],
    };
    var all = [].concat(soul.up, soul.down, soul.mid);
    function randomNumber(range) {
      var r = Math.floor(Math.random() * range);
      return r;
    }
    function isChar(character) {
      var bool = false;
      all.filter(function (i) {
        bool = i === character;
      });
      return bool;
    }
    function heComes(text2, options2) {
      var result = '';
      var counts;
      var l;
      options2 = options2 || {};
      options2['up'] = typeof options2['up'] !== 'undefined' ? options2['up'] : true;
      options2['mid'] = typeof options2['mid'] !== 'undefined' ? options2['mid'] : true;
      options2['down'] = typeof options2['down'] !== 'undefined' ? options2['down'] : true;
      options2['size'] = typeof options2['size'] !== 'undefined' ? options2['size'] : 'maxi';
      text2 = text2.split('');
      for (l in text2) {
        if (isChar(l)) {
          continue;
        }
        result = result + text2[l];
        counts = { up: 0, down: 0, mid: 0 };
        switch (options2.size) {
          case 'mini':
            counts.up = randomNumber(8);
            counts.mid = randomNumber(2);
            counts.down = randomNumber(8);
            break;
          case 'maxi':
            counts.up = randomNumber(16) + 3;
            counts.mid = randomNumber(4) + 1;
            counts.down = randomNumber(64) + 3;
            break;
          default:
            counts.up = randomNumber(8) + 1;
            counts.mid = randomNumber(6) / 2;
            counts.down = randomNumber(8) + 1;
            break;
        }
        var arr = ['up', 'mid', 'down'];
        for (var d in arr) {
          var index = arr[d];
          for (var i = 0; i <= counts[index]; i++) {
            if (options2[index]) {
              result = result + soul[index][randomNumber(soul[index].length)];
            }
          }
        }
      }
      return result;
    }
    return heComes(text, options);
  };
});

// node_modules/@colors/colors/lib/maps/america.js
var require_america = __commonJS((exports, module) => {
  module['exports'] = function (colors) {
    return function (letter, i, exploded) {
      if (letter === ' ') return letter;
      switch (i % 3) {
        case 0:
          return colors.red(letter);
        case 1:
          return colors.white(letter);
        case 2:
          return colors.blue(letter);
      }
    };
  };
});

// node_modules/@colors/colors/lib/maps/zebra.js
var require_zebra = __commonJS((exports, module) => {
  module['exports'] = function (colors) {
    return function (letter, i, exploded) {
      return i % 2 === 0 ? letter : colors.inverse(letter);
    };
  };
});

// node_modules/@colors/colors/lib/maps/rainbow.js
var require_rainbow = __commonJS((exports, module) => {
  module['exports'] = function (colors) {
    var rainbowColors = ['red', 'yellow', 'green', 'blue', 'magenta'];
    return function (letter, i, exploded) {
      if (letter === ' ') {
        return letter;
      } else {
        return colors[rainbowColors[i++ % rainbowColors.length]](letter);
      }
    };
  };
});

// node_modules/@colors/colors/lib/maps/random.js
var require_random = __commonJS((exports, module) => {
  module['exports'] = function (colors) {
    var available = [
      'underline',
      'inverse',
      'grey',
      'yellow',
      'red',
      'green',
      'blue',
      'white',
      'cyan',
      'magenta',
      'brightYellow',
      'brightRed',
      'brightGreen',
      'brightBlue',
      'brightWhite',
      'brightCyan',
      'brightMagenta',
    ];
    return function (letter, i, exploded) {
      return letter === ' ' ? letter : colors[available[Math.round(Math.random() * (available.length - 2))]](letter);
    };
  };
});

// node_modules/@colors/colors/lib/colors.js
var require_colors = __commonJS((exports, module) => {
  var colors = {};
  module['exports'] = colors;
  colors.themes = {};
  var util3 = __require('util');
  var ansiStyles = (colors.styles = require_styles());
  var defineProps = Object.defineProperties;
  var newLineRegex = new RegExp(/[\r\n]+/g);
  colors.supportsColor = require_supports_colors().supportsColor;
  if (typeof colors.enabled === 'undefined') {
    colors.enabled = colors.supportsColor() !== false;
  }
  colors.enable = function () {
    colors.enabled = true;
  };
  colors.disable = function () {
    colors.enabled = false;
  };
  colors.stripColors = colors.strip = function (str) {
    return ('' + str).replace(/\x1B\[\d+m/g, '');
  };
  var stylize = (colors.stylize = function stylize2(str, style) {
    if (!colors.enabled) {
      return str + '';
    }
    var styleMap = ansiStyles[style];
    if (!styleMap && style in colors) {
      return colors[style](str);
    }
    return styleMap.open + str + styleMap.close;
  });
  var matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g;
  var escapeStringRegexp = function (str) {
    if (typeof str !== 'string') {
      throw new TypeError('Expected a string');
    }
    return str.replace(matchOperatorsRe, '\\$&');
  };
  function build(_styles) {
    var builder = function builder2() {
      return applyStyle.apply(builder2, arguments);
    };
    builder._styles = _styles;
    builder.__proto__ = proto;
    return builder;
  }
  var styles = (function () {
    var ret = {};
    ansiStyles.grey = ansiStyles.gray;
    Object.keys(ansiStyles).forEach(function (key) {
      ansiStyles[key].closeRe = new RegExp(escapeStringRegexp(ansiStyles[key].close), 'g');
      ret[key] = {
        get: function () {
          return build(this._styles.concat(key));
        },
      };
    });
    return ret;
  })();
  var proto = defineProps(function colors2() {}, styles);
  function applyStyle() {
    var args = Array.prototype.slice.call(arguments);
    var str = args
      .map(function (arg) {
        if (arg != null && arg.constructor === String) {
          return arg;
        } else {
          return util3.inspect(arg);
        }
      })
      .join(' ');
    if (!colors.enabled || !str) {
      return str;
    }
    var newLinesPresent =
      str.indexOf(`
`) != -1;
    var nestedStyles = this._styles;
    var i = nestedStyles.length;
    while (i--) {
      var code = ansiStyles[nestedStyles[i]];
      str = code.open + str.replace(code.closeRe, code.open) + code.close;
      if (newLinesPresent) {
        str = str.replace(newLineRegex, function (match2) {
          return code.close + match2 + code.open;
        });
      }
    }
    return str;
  }
  colors.setTheme = function (theme) {
    if (typeof theme === 'string') {
      console.log(
        'colors.setTheme now only accepts an object, not a string.  ' +
          'If you are trying to set a theme from a file, it is now your (the ' +
          "caller's) responsibility to require the file.  The old syntax " +
          'looked like colors.setTheme(__dirname + ' +
          "'/../themes/generic-logging.js'); The new syntax looks like " +
          'colors.setTheme(require(__dirname + ' +
          "'/../themes/generic-logging.js'));",
      );
      return;
    }
    for (var style in theme) {
      (function (style2) {
        colors[style2] = function (str) {
          if (typeof theme[style2] === 'object') {
            var out = str;
            for (var i in theme[style2]) {
              out = colors[theme[style2][i]](out);
            }
            return out;
          }
          return colors[theme[style2]](str);
        };
      })(style);
    }
  };
  function init() {
    var ret = {};
    Object.keys(styles).forEach(function (name) {
      ret[name] = {
        get: function () {
          return build([name]);
        },
      };
    });
    return ret;
  }
  var sequencer = function sequencer2(map2, str) {
    var exploded = str.split('');
    exploded = exploded.map(map2);
    return exploded.join('');
  };
  colors.trap = require_trap();
  colors.zalgo = require_zalgo();
  colors.maps = {};
  colors.maps.america = require_america()(colors);
  colors.maps.zebra = require_zebra()(colors);
  colors.maps.rainbow = require_rainbow()(colors);
  colors.maps.random = require_random()(colors);
  for (map in colors.maps) {
    (function (map2) {
      colors[map2] = function (str) {
        return sequencer(colors.maps[map2], str);
      };
    })(map);
  }
  var map;
  defineProps(colors, init());
});

// node_modules/@colors/colors/safe.js
var require_safe = __commonJS((exports, module) => {
  var colors = require_colors();
  module['exports'] = colors;
});

// node_modules/cli-table3/src/cell.js
var require_cell = __commonJS((exports, module) => {
  var { info, debug } = require_debug();
  var utils = require_utils();

  class Cell {
    constructor(options) {
      this.setOptions(options);
      this.x = null;
      this.y = null;
    }
    setOptions(options) {
      if (['boolean', 'number', 'bigint', 'string'].indexOf(typeof options) !== -1) {
        options = { content: '' + options };
      }
      options = options || {};
      this.options = options;
      let content = options.content;
      if (['boolean', 'number', 'bigint', 'string'].indexOf(typeof content) !== -1) {
        this.content = String(content);
      } else if (!content) {
        this.content = this.options.href || '';
      } else {
        throw new Error('Content needs to be a primitive, got: ' + typeof content);
      }
      this.colSpan = options.colSpan || 1;
      this.rowSpan = options.rowSpan || 1;
      if (this.options.href) {
        Object.defineProperty(this, 'href', {
          get() {
            return this.options.href;
          },
        });
      }
    }
    mergeTableOptions(tableOptions, cells) {
      this.cells = cells;
      let optionsChars = this.options.chars || {};
      let tableChars = tableOptions.chars;
      let chars = (this.chars = {});
      CHAR_NAMES.forEach(function (name) {
        setOption(optionsChars, tableChars, name, chars);
      });
      this.truncate = this.options.truncate || tableOptions.truncate;
      let style = (this.options.style = this.options.style || {});
      let tableStyle = tableOptions.style;
      setOption(style, tableStyle, 'padding-left', this);
      setOption(style, tableStyle, 'padding-right', this);
      this.head = style.head || tableStyle.head;
      this.border = style.border || tableStyle.border;
      this.fixedWidth = tableOptions.colWidths[this.x];
      this.lines = this.computeLines(tableOptions);
      this.desiredWidth = utils.strlen(this.content) + this.paddingLeft + this.paddingRight;
      this.desiredHeight = this.lines.length;
    }
    computeLines(tableOptions) {
      const tableWordWrap = tableOptions.wordWrap || tableOptions.textWrap;
      const { wordWrap = tableWordWrap } = this.options;
      if (this.fixedWidth && wordWrap) {
        this.fixedWidth -= this.paddingLeft + this.paddingRight;
        if (this.colSpan) {
          let i = 1;
          while (i < this.colSpan) {
            this.fixedWidth += tableOptions.colWidths[this.x + i];
            i++;
          }
        }
        const { wrapOnWordBoundary: tableWrapOnWordBoundary = true } = tableOptions;
        const { wrapOnWordBoundary = tableWrapOnWordBoundary } = this.options;
        return this.wrapLines(utils.wordWrap(this.fixedWidth, this.content, wrapOnWordBoundary));
      }
      return this.wrapLines(
        this.content.split(`
`),
      );
    }
    wrapLines(computedLines) {
      const lines = utils.colorizeLines(computedLines);
      if (this.href) {
        return lines.map(line => utils.hyperlink(this.href, line));
      }
      return lines;
    }
    init(tableOptions) {
      let x = this.x;
      let y = this.y;
      this.widths = tableOptions.colWidths.slice(x, x + this.colSpan);
      this.heights = tableOptions.rowHeights.slice(y, y + this.rowSpan);
      this.width = this.widths.reduce(sumPlusOne, -1);
      this.height = this.heights.reduce(sumPlusOne, -1);
      this.hAlign = this.options.hAlign || tableOptions.colAligns[x];
      this.vAlign = this.options.vAlign || tableOptions.rowAligns[y];
      this.drawRight = x + this.colSpan == tableOptions.colWidths.length;
    }
    draw(lineNum, spanningCell) {
      if (lineNum == 'top') return this.drawTop(this.drawRight);
      if (lineNum == 'bottom') return this.drawBottom(this.drawRight);
      let content = utils.truncate(this.content, 10, this.truncate);
      if (!lineNum) {
        info(`${this.y}-${this.x}: ${this.rowSpan - lineNum}x${this.colSpan} Cell ${content}`);
      } else {
      }
      let padLen = Math.max(this.height - this.lines.length, 0);
      let padTop;
      switch (this.vAlign) {
        case 'center':
          padTop = Math.ceil(padLen / 2);
          break;
        case 'bottom':
          padTop = padLen;
          break;
        default:
          padTop = 0;
      }
      if (lineNum < padTop || lineNum >= padTop + this.lines.length) {
        return this.drawEmpty(this.drawRight, spanningCell);
      }
      let forceTruncation = this.lines.length > this.height && lineNum + 1 >= this.height;
      return this.drawLine(lineNum - padTop, this.drawRight, forceTruncation, spanningCell);
    }
    drawTop(drawRight) {
      let content = [];
      if (this.cells) {
        this.widths.forEach(function (width, index) {
          content.push(this._topLeftChar(index));
          content.push(utils.repeat(this.chars[this.y == 0 ? 'top' : 'mid'], width));
        }, this);
      } else {
        content.push(this._topLeftChar(0));
        content.push(utils.repeat(this.chars[this.y == 0 ? 'top' : 'mid'], this.width));
      }
      if (drawRight) {
        content.push(this.chars[this.y == 0 ? 'topRight' : 'rightMid']);
      }
      return this.wrapWithStyleColors('border', content.join(''));
    }
    _topLeftChar(offset) {
      let x = this.x + offset;
      let leftChar;
      if (this.y == 0) {
        leftChar = x == 0 ? 'topLeft' : offset == 0 ? 'topMid' : 'top';
      } else {
        if (x == 0) {
          leftChar = 'leftMid';
        } else {
          leftChar = offset == 0 ? 'midMid' : 'bottomMid';
          if (this.cells) {
            let spanAbove = this.cells[this.y - 1][x] instanceof Cell.ColSpanCell;
            if (spanAbove) {
              leftChar = offset == 0 ? 'topMid' : 'mid';
            }
            if (offset == 0) {
              let i = 1;
              while (this.cells[this.y][x - i] instanceof Cell.ColSpanCell) {
                i++;
              }
              if (this.cells[this.y][x - i] instanceof Cell.RowSpanCell) {
                leftChar = 'leftMid';
              }
            }
          }
        }
      }
      return this.chars[leftChar];
    }
    wrapWithStyleColors(styleProperty, content) {
      if (this[styleProperty] && this[styleProperty].length) {
        try {
          let colors = require_safe();
          for (let i = this[styleProperty].length - 1; i >= 0; i--) {
            colors = colors[this[styleProperty][i]];
          }
          return colors(content);
        } catch (e) {
          return content;
        }
      } else {
        return content;
      }
    }
    drawLine(lineNum, drawRight, forceTruncationSymbol, spanningCell) {
      let left = this.chars[this.x == 0 ? 'left' : 'middle'];
      if (this.x && spanningCell && this.cells) {
        let cellLeft = this.cells[this.y + spanningCell][this.x - 1];
        while (cellLeft instanceof ColSpanCell) {
          cellLeft = this.cells[cellLeft.y][cellLeft.x - 1];
        }
        if (!(cellLeft instanceof RowSpanCell)) {
          left = this.chars['rightMid'];
        }
      }
      let leftPadding = utils.repeat(' ', this.paddingLeft);
      let right = drawRight ? this.chars['right'] : '';
      let rightPadding = utils.repeat(' ', this.paddingRight);
      let line = this.lines[lineNum];
      let len = this.width - (this.paddingLeft + this.paddingRight);
      if (forceTruncationSymbol) line += this.truncate || '\u2026';
      let content = utils.truncate(line, len, this.truncate);
      content = utils.pad(content, len, ' ', this.hAlign);
      content = leftPadding + content + rightPadding;
      return this.stylizeLine(left, content, right);
    }
    stylizeLine(left, content, right) {
      left = this.wrapWithStyleColors('border', left);
      right = this.wrapWithStyleColors('border', right);
      if (this.y === 0) {
        content = this.wrapWithStyleColors('head', content);
      }
      return left + content + right;
    }
    drawBottom(drawRight) {
      let left = this.chars[this.x == 0 ? 'bottomLeft' : 'bottomMid'];
      let content = utils.repeat(this.chars.bottom, this.width);
      let right = drawRight ? this.chars['bottomRight'] : '';
      return this.wrapWithStyleColors('border', left + content + right);
    }
    drawEmpty(drawRight, spanningCell) {
      let left = this.chars[this.x == 0 ? 'left' : 'middle'];
      if (this.x && spanningCell && this.cells) {
        let cellLeft = this.cells[this.y + spanningCell][this.x - 1];
        while (cellLeft instanceof ColSpanCell) {
          cellLeft = this.cells[cellLeft.y][cellLeft.x - 1];
        }
        if (!(cellLeft instanceof RowSpanCell)) {
          left = this.chars['rightMid'];
        }
      }
      let right = drawRight ? this.chars['right'] : '';
      let content = utils.repeat(' ', this.width);
      return this.stylizeLine(left, content, right);
    }
  }

  class ColSpanCell {
    constructor() {}
    draw(lineNum) {
      if (typeof lineNum === 'number') {
        debug(`${this.y}-${this.x}: 1x1 ColSpanCell`);
      }
      return '';
    }
    init() {}
    mergeTableOptions() {}
  }

  class RowSpanCell {
    constructor(originalCell) {
      this.originalCell = originalCell;
    }
    init(tableOptions) {
      let y = this.y;
      let originalY = this.originalCell.y;
      this.cellOffset = y - originalY;
      this.offset = findDimension(tableOptions.rowHeights, originalY, this.cellOffset);
    }
    draw(lineNum) {
      if (lineNum == 'top') {
        return this.originalCell.draw(this.offset, this.cellOffset);
      }
      if (lineNum == 'bottom') {
        return this.originalCell.draw('bottom');
      }
      debug(`${this.y}-${this.x}: 1x${this.colSpan} RowSpanCell for ${this.originalCell.content}`);
      return this.originalCell.draw(this.offset + 1 + lineNum);
    }
    mergeTableOptions() {}
  }
  function firstDefined(...args) {
    return args.filter(v => v !== undefined && v !== null).shift();
  }
  function setOption(objA, objB, nameB, targetObj) {
    let nameA = nameB.split('-');
    if (nameA.length > 1) {
      nameA[1] = nameA[1].charAt(0).toUpperCase() + nameA[1].substr(1);
      nameA = nameA.join('');
      targetObj[nameA] = firstDefined(objA[nameA], objA[nameB], objB[nameA], objB[nameB]);
    } else {
      targetObj[nameB] = firstDefined(objA[nameB], objB[nameB]);
    }
  }
  function findDimension(dimensionTable, startingIndex, span) {
    let ret = dimensionTable[startingIndex];
    for (let i = 1; i < span; i++) {
      ret += 1 + dimensionTable[startingIndex + i];
    }
    return ret;
  }
  function sumPlusOne(a, b) {
    return a + b + 1;
  }
  var CHAR_NAMES = [
    'top',
    'top-mid',
    'top-left',
    'top-right',
    'bottom',
    'bottom-mid',
    'bottom-left',
    'bottom-right',
    'left',
    'left-mid',
    'mid',
    'mid-mid',
    'right',
    'right-mid',
    'middle',
  ];
  module.exports = Cell;
  module.exports.ColSpanCell = ColSpanCell;
  module.exports.RowSpanCell = RowSpanCell;
});

// node_modules/cli-table3/src/layout-manager.js
var require_layout_manager = __commonJS((exports, module) => {
  var { warn, debug } = require_debug();
  var Cell = require_cell();
  var { ColSpanCell, RowSpanCell } = Cell;
  (function () {
    function next(alloc, col) {
      if (alloc[col] > 0) {
        return next(alloc, col + 1);
      }
      return col;
    }
    function layoutTable(table) {
      let alloc = {};
      table.forEach(function (row, rowIndex) {
        let col = 0;
        row.forEach(function (cell) {
          cell.y = rowIndex;
          cell.x = rowIndex ? next(alloc, col) : col;
          const rowSpan = cell.rowSpan || 1;
          const colSpan = cell.colSpan || 1;
          if (rowSpan > 1) {
            for (let cs = 0; cs < colSpan; cs++) {
              alloc[cell.x + cs] = rowSpan;
            }
          }
          col = cell.x + colSpan;
        });
        Object.keys(alloc).forEach(idx => {
          alloc[idx]--;
          if (alloc[idx] < 1) delete alloc[idx];
        });
      });
    }
    function maxWidth(table) {
      let mw = 0;
      table.forEach(function (row) {
        row.forEach(function (cell) {
          mw = Math.max(mw, cell.x + (cell.colSpan || 1));
        });
      });
      return mw;
    }
    function maxHeight(table) {
      return table.length;
    }
    function cellsConflict(cell1, cell2) {
      let yMin1 = cell1.y;
      let yMax1 = cell1.y - 1 + (cell1.rowSpan || 1);
      let yMin2 = cell2.y;
      let yMax2 = cell2.y - 1 + (cell2.rowSpan || 1);
      let yConflict = !(yMin1 > yMax2 || yMin2 > yMax1);
      let xMin1 = cell1.x;
      let xMax1 = cell1.x - 1 + (cell1.colSpan || 1);
      let xMin2 = cell2.x;
      let xMax2 = cell2.x - 1 + (cell2.colSpan || 1);
      let xConflict = !(xMin1 > xMax2 || xMin2 > xMax1);
      return yConflict && xConflict;
    }
    function conflictExists(rows, x, y) {
      let i_max = Math.min(rows.length - 1, y);
      let cell = { x, y };
      for (let i = 0; i <= i_max; i++) {
        let row = rows[i];
        for (let j = 0; j < row.length; j++) {
          if (cellsConflict(cell, row[j])) {
            return true;
          }
        }
      }
      return false;
    }
    function allBlank(rows, y, xMin, xMax) {
      for (let x = xMin; x < xMax; x++) {
        if (conflictExists(rows, x, y)) {
          return false;
        }
      }
      return true;
    }
    function addRowSpanCells(table) {
      table.forEach(function (row, rowIndex) {
        row.forEach(function (cell) {
          for (let i = 1; i < cell.rowSpan; i++) {
            let rowSpanCell = new RowSpanCell(cell);
            rowSpanCell.x = cell.x;
            rowSpanCell.y = cell.y + i;
            rowSpanCell.colSpan = cell.colSpan;
            insertCell(rowSpanCell, table[rowIndex + i]);
          }
        });
      });
    }
    function addColSpanCells(cellRows) {
      for (let rowIndex = cellRows.length - 1; rowIndex >= 0; rowIndex--) {
        let cellColumns = cellRows[rowIndex];
        for (let columnIndex = 0; columnIndex < cellColumns.length; columnIndex++) {
          let cell = cellColumns[columnIndex];
          for (let k = 1; k < cell.colSpan; k++) {
            let colSpanCell = new ColSpanCell();
            colSpanCell.x = cell.x + k;
            colSpanCell.y = cell.y;
            cellColumns.splice(columnIndex + 1, 0, colSpanCell);
          }
        }
      }
    }
    function insertCell(cell, row) {
      let x = 0;
      while (x < row.length && row[x].x < cell.x) {
        x++;
      }
      row.splice(x, 0, cell);
    }
    function fillInTable(table) {
      let h_max = maxHeight(table);
      let w_max = maxWidth(table);
      debug(`Max rows: ${h_max}; Max cols: ${w_max}`);
      for (let y = 0; y < h_max; y++) {
        for (let x = 0; x < w_max; x++) {
          if (!conflictExists(table, x, y)) {
            let opts = { x, y, colSpan: 1, rowSpan: 1 };
            x++;
            while (x < w_max && !conflictExists(table, x, y)) {
              opts.colSpan++;
              x++;
            }
            let y2 = y + 1;
            while (y2 < h_max && allBlank(table, y2, opts.x, opts.x + opts.colSpan)) {
              opts.rowSpan++;
              y2++;
            }
            let cell = new Cell(opts);
            cell.x = opts.x;
            cell.y = opts.y;
            warn(`Missing cell at ${cell.y}-${cell.x}.`);
            insertCell(cell, table[y]);
          }
        }
      }
    }
    function generateCells(rows) {
      return rows.map(function (row) {
        if (!Array.isArray(row)) {
          let key = Object.keys(row)[0];
          row = row[key];
          if (Array.isArray(row)) {
            row = row.slice();
            row.unshift(key);
          } else {
            row = [key, row];
          }
        }
        return row.map(function (cell) {
          return new Cell(cell);
        });
      });
    }
    function makeTableLayout(rows) {
      let cellRows = generateCells(rows);
      layoutTable(cellRows);
      fillInTable(cellRows);
      addRowSpanCells(cellRows);
      addColSpanCells(cellRows);
      return cellRows;
    }
    module.exports = {
      makeTableLayout,
      layoutTable,
      addRowSpanCells,
      maxWidth,
      fillInTable,
      computeWidths: makeComputeWidths('colSpan', 'desiredWidth', 'x', 1),
      computeHeights: makeComputeWidths('rowSpan', 'desiredHeight', 'y', 1),
    };
  })();
  function makeComputeWidths(colSpan, desiredWidth, x, forcedMin) {
    return function (vals, table) {
      let result = [];
      let spanners = [];
      let auto = {};
      table.forEach(function (row) {
        row.forEach(function (cell) {
          if ((cell[colSpan] || 1) > 1) {
            spanners.push(cell);
          } else {
            result[cell[x]] = Math.max(result[cell[x]] || 0, cell[desiredWidth] || 0, forcedMin);
          }
        });
      });
      vals.forEach(function (val, index) {
        if (typeof val === 'number') {
          result[index] = val;
        }
      });
      for (let k = spanners.length - 1; k >= 0; k--) {
        let cell = spanners[k];
        let span = cell[colSpan];
        let col = cell[x];
        let existingWidth = result[col];
        let editableCols = typeof vals[col] === 'number' ? 0 : 1;
        if (typeof existingWidth === 'number') {
          for (let i = 1; i < span; i++) {
            existingWidth += 1 + result[col + i];
            if (typeof vals[col + i] !== 'number') {
              editableCols++;
            }
          }
        } else {
          existingWidth = desiredWidth === 'desiredWidth' ? cell.desiredWidth - 1 : 1;
          if (!auto[col] || auto[col] < existingWidth) {
            auto[col] = existingWidth;
          }
        }
        if (cell[desiredWidth] > existingWidth) {
          let i = 0;
          while (editableCols > 0 && cell[desiredWidth] > existingWidth) {
            if (typeof vals[col + i] !== 'number') {
              let dif = Math.round((cell[desiredWidth] - existingWidth) / editableCols);
              existingWidth += dif;
              result[col + i] += dif;
              editableCols--;
            }
            i++;
          }
        }
      }
      Object.assign(vals, result, auto);
      for (let j = 0; j < vals.length; j++) {
        vals[j] = Math.max(forcedMin, vals[j] || 0);
      }
    };
  }
});

// node_modules/cli-table3/src/table.js
var require_table = __commonJS((exports, module) => {
  var debug = require_debug();
  var utils = require_utils();
  var tableLayout = require_layout_manager();

  class Table extends Array {
    constructor(opts) {
      super();
      const options = utils.mergeOptions(opts);
      Object.defineProperty(this, 'options', {
        value: options,
        enumerable: options.debug,
      });
      if (options.debug) {
        switch (typeof options.debug) {
          case 'boolean':
            debug.setDebugLevel(debug.WARN);
            break;
          case 'number':
            debug.setDebugLevel(options.debug);
            break;
          case 'string':
            debug.setDebugLevel(parseInt(options.debug, 10));
            break;
          default:
            debug.setDebugLevel(debug.WARN);
            debug.warn(`Debug option is expected to be boolean, number, or string. Received a ${typeof options.debug}`);
        }
        Object.defineProperty(this, 'messages', {
          get() {
            return debug.debugMessages();
          },
        });
      }
    }
    toString() {
      let array = this;
      let headersPresent = this.options.head && this.options.head.length;
      if (headersPresent) {
        array = [this.options.head];
        if (this.length) {
          array.push.apply(array, this);
        }
      } else {
        this.options.style.head = [];
      }
      let cells = tableLayout.makeTableLayout(array);
      cells.forEach(function (row) {
        row.forEach(function (cell) {
          cell.mergeTableOptions(this.options, cells);
        }, this);
      }, this);
      tableLayout.computeWidths(this.options.colWidths, cells);
      tableLayout.computeHeights(this.options.rowHeights, cells);
      cells.forEach(function (row) {
        row.forEach(function (cell) {
          cell.init(this.options);
        }, this);
      }, this);
      let result = [];
      for (let rowIndex = 0; rowIndex < cells.length; rowIndex++) {
        let row = cells[rowIndex];
        let heightOfRow = this.options.rowHeights[rowIndex];
        if (rowIndex === 0 || !this.options.style.compact || (rowIndex == 1 && headersPresent)) {
          doDraw(row, 'top', result);
        }
        for (let lineNum = 0; lineNum < heightOfRow; lineNum++) {
          doDraw(row, lineNum, result);
        }
        if (rowIndex + 1 == cells.length) {
          doDraw(row, 'bottom', result);
        }
      }
      return result.join(`
`);
    }
    get width() {
      let str = this.toString().split(`
`);
      return str[0].length;
    }
  }
  Table.reset = () => debug.reset();
  function doDraw(row, lineNum, result) {
    let line = [];
    row.forEach(function (cell) {
      line.push(cell.draw(lineNum));
    });
    let str = line.join('');
    if (str.length) result.push(str);
  }
  module.exports = Table;
});

// node_modules/sisteransi/src/index.js
var require_src = __commonJS((exports, module) => {
  var ESC = '\x1B';
  var CSI = `${ESC}[`;
  var beep = '\x07';
  var cursor = {
    to(x, y) {
      if (!y) return `${CSI}${x + 1}G`;
      return `${CSI}${y + 1};${x + 1}H`;
    },
    move(x, y) {
      let ret = '';
      if (x < 0) ret += `${CSI}${-x}D`;
      else if (x > 0) ret += `${CSI}${x}C`;
      if (y < 0) ret += `${CSI}${-y}A`;
      else if (y > 0) ret += `${CSI}${y}B`;
      return ret;
    },
    up: (count = 1) => `${CSI}${count}A`,
    down: (count = 1) => `${CSI}${count}B`,
    forward: (count = 1) => `${CSI}${count}C`,
    backward: (count = 1) => `${CSI}${count}D`,
    nextLine: (count = 1) => `${CSI}E`.repeat(count),
    prevLine: (count = 1) => `${CSI}F`.repeat(count),
    left: `${CSI}G`,
    hide: `${CSI}?25l`,
    show: `${CSI}?25h`,
    save: `${ESC}7`,
    restore: `${ESC}8`,
  };
  var scroll = {
    up: (count = 1) => `${CSI}S`.repeat(count),
    down: (count = 1) => `${CSI}T`.repeat(count),
  };
  var erase = {
    screen: `${CSI}2J`,
    up: (count = 1) => `${CSI}1J`.repeat(count),
    down: (count = 1) => `${CSI}J`.repeat(count),
    line: `${CSI}2K`,
    lineEnd: `${CSI}K`,
    lineStart: `${CSI}1K`,
    lines(count) {
      let clear = '';
      for (let i = 0; i < count; i++) clear += this.line + (i < count - 1 ? cursor.up() : '');
      if (count) clear += cursor.left;
      return clear;
    },
  };
  module.exports = { cursor, scroll, erase, beep };
});

// node_modules/commander/esm.mjs
var import__ = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  Command,
  Argument,
  Option,
  Help,
} = import__.default;

// src/cli/init.ts
var import_picocolors = __toESM(require_picocolors(), 1);
import * as path2 from 'path';
import * as fs2 from 'fs/promises';

// src/deps.ts
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
var BASE_DIR = '.kagent';
var CURRENT_DIR = `${BASE_DIR}/current`;
var SESSIONS_DIR = `${CURRENT_DIR}/sessions`;
var VERDICTS_DIR = `${CURRENT_DIR}/verdicts`;
var EVIDENCE_DIR = `${CURRENT_DIR}/evidence`;
var HISTORY_DIR = `${BASE_DIR}/history`;
var LOGS_DIR = `${BASE_DIR}/logs`;
var REVIEWS_DIR = `${BASE_DIR}/reviews`;
var METRICS_DIR = `${BASE_DIR}/metrics`;
function getKloopHome() {
  return process.env.KLOOP_HOME ?? path.join(os.homedir(), '.kloop');
}
var paths = {
  baseDir: BASE_DIR,
  spec: `${BASE_DIR}/spec.md`,
  config: `${BASE_DIR}/config.json`,
  currentDir: CURRENT_DIR,
  runJson: `${CURRENT_DIR}/run.json`,
  sessionsDir: SESSIONS_DIR,
  verdictsDir: VERDICTS_DIR,
  evidenceDir: EVIDENCE_DIR,
  evidenceMd: `${EVIDENCE_DIR}/evidence.md`,
  learnings: `${CURRENT_DIR}/learnings.md`,
  historyDir: HISTORY_DIR,
  logsDir: LOGS_DIR,
  reviewsDir: REVIEWS_DIR,
  metricsDir: METRICS_DIR,
  failureMd: `${BASE_DIR}/failure.md`,
  historyEntry: runId => `${HISTORY_DIR}/${runId}.json`,
  verdictFile: (iteration, reviewerIndex) => `${VERDICTS_DIR}/${iteration}-${reviewerIndex}.json`,
  sessionFile: sessionId => `${SESSIONS_DIR}/${sessionId}.json`,
  runLogsDir: runId => `${LOGS_DIR}/${runId}`,
  runReviewsDir: runId => `${REVIEWS_DIR}/${runId}`,
  metricsFile: runId => `${METRICS_DIR}/${runId}.jsonl`,
  kloopHome: getKloopHome(),
  indexDb: path.join(getKloopHome(), 'index.db'),
  lockFile: runId => path.join(getKloopHome(), `${runId}.lock`),
  runPath: runId => path.join(getKloopHome(), runId),
  loopPath: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`),
  agentPath: (runId, loopIndex, agentName) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, agentName),
  runConfig: runId => path.join(getKloopHome(), runId, 'config.yaml'),
  runSpec: runId => path.join(getKloopHome(), runId, 'spec.md'),
  runSpecVersioned: (runId, version) => path.join(getKloopHome(), runId, `spec-${version}.md`),
  runEvents: runId => path.join(getKloopHome(), runId, 'events.jsonl'),
  runStatus: runId => path.join(getKloopHome(), runId, 'status.yaml'),
  runLearnings: runId => path.join(getKloopHome(), runId, 'learnings.md'),
  runLog: runId => path.join(getKloopHome(), runId, 'run.log'),
  loopSummaryMd: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'summary.md'),
  loopSummaryJson: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'summary.json'),
  loopLearningMd: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'learning.md'),
  loopCheckpoint: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'checkpoint.json'),
  loopMetrics: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'metrics.jsonl'),
  loopImplementerPath: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'implementer'),
  loopReviewerPath: (runId, loopIndex, reviewerIndex) =>
    path.join(getKloopHome(), runId, `loop-${loopIndex}`, `reviewer-${reviewerIndex}`),
  loopEvidencePath: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'evidence'),
  loopReviewsPath: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'reviews'),
  loopVerdictsPath: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'verdicts'),
  loopCheckpointerPath: (runId, loopIndex) => path.join(getKloopHome(), runId, `loop-${loopIndex}`, 'checkpointer'),
};

class DefaultFsService {
  async mkdir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  async readFile(filePath) {
    return await fs.readFile(filePath, 'utf-8');
  }
  async readJson(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  async writeFile(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
  async writeJson(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
  async unlink(filePath) {
    await fs.unlink(filePath);
  }
  async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async readdir(dirPath) {
    return await fs.readdir(dirPath);
  }
  async rm(dirPath, options = { recursive: false }) {
    await fs.rm(dirPath, options);
  }
}
var defaultFsService = new DefaultFsService();
function generateId() {
  return crypto.randomUUID();
}
function generateRunId() {
  return crypto.randomUUID().slice(0, 8);
}
var { customAlphabet: customAlphabet2 } = (init_nanoid(), __toCommonJS(exports_nanoid));
var _kloopNanoid = customAlphabet2('0123456789abcdefghijklmnopqrstuvwxyz', 8);
function generateKloopRunId() {
  return _kloopNanoid();
}
function getDirHash(dirPath) {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(dirPath);
  return hasher.digest('hex').slice(0, 8);
}
function getCurrentTimestamp() {
  return new Date().toISOString();
}
var SPEC_TEMPLATE = `# Specification: [Title]

## Objective
[Clear, concise description of what to build]

## Acceptance Criteria
- [ ] Criterion 1 (specific, measurable)
- [ ] Criterion 2
- [ ] Criterion 3

## Definition of Done
- [ ] All acceptance criteria met
- [ ] Tests pass (if applicable)
- [ ] No lint/type errors (if applicable)

## Out of Scope
- [What this task does NOT include]

## Technical Constraints
- [Any specific requirements or limitations]
`;
async function nextSpecVersion(runId) {
  const runDir = paths.runPath(runId);
  try {
    const files = await fs.readdir(runDir);
    let maxVersion = 0;
    for (const f of files) {
      const match = f.match(/^spec-(\d+)\.md$/);
      if (match) {
        const v = parseInt(match[1], 10);
        if (v > maxVersion) maxVersion = v;
      }
    }
    return maxVersion + 1;
  } catch {
    return 1;
  }
}

// src/agents/default-prompts.ts
var DEFAULT_IMPLEMENTER_PROMPT = `# Implementation Task

## Specification

Read the spec from: {specPath}
Read CLAUDE.md and any project skills files if they exist.

## Context

- Loop: {iteration}
- Reviews from previous loop: {reviewsDir}/
- Learnings from previous loops: {learningsFile}

## Instructions

1. Read and understand the specification completely \u2014 especially the Definition of Done checklist
2. Before using any library, tool, or framework, research its current documentation and source code. Verify the version you are using matches the API signatures and configuration you are relying on. Do not rely on potentially outdated knowledge.
3. Address any review feedback or learnings from above
4. Implement the required changes
5. Capture evidence to {evidenceDir}/:
   - If the spec has a Definition of Done checklist, capture evidence for each item
   - If the spec has no checklist, figure out what checks are available (build, test, lint, type-check, etc.) and capture what you can
6. Write learnings to {learningsFile}: roadblocks, workarounds, decisions made, and why

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches or rebase pushed commits
- Do NOT commit changes \u2014 the run will commit on successful completion`;
var DEFAULT_REVIEWER_PROMPT = `# Code Review Task

## Specification

Read the spec from: {specPath}
Read CLAUDE.md and any project skills files if they exist.

## Previous Loop Reviews
{archivedReviews}

## Your Task

You are Reviewer {reviewerIndex} for loop {iteration}. Be strict and thorough.

1. Run \`git diff\` and \`git diff --staged\` to see all changes
2. Review every changed file against the specification \u2014 not just a summary
3. Before using any library, tool, or framework referenced in the code, research its current documentation and source code. Verify the version being used matches the actual API signature and configuration. Flag any usage of outdated or non-existent features.
4. Check {evidenceDir}/ for build, test, and other output logs \u2014 trust these as accurate to save time
5. **Validate evidence** \u2014 check {evidenceDir}/ for output logs
   - If the spec has a Definition of Done checklist, be strict: every required evidence item must be present and passing. Reject if anything is missing.
   - If the spec has no checklist, use judgment: check what is reasonable for this project. Don't reject for missing evidence that the spec never asked for.
6. Write your review to {reviewsDir}/reviewer-{reviewerIndex}.md \u2014 include any issues found and evidence gaps
7. Write your verdict to {verdictsDir}/reviewer-{reviewerIndex}.json:
   \`\`\`json
   {
     "approved": true,
     "reasoning": "Your detailed reasoning here",
     "completionEstimate": 0-100 (be conservative, 100% only if ALL acceptance criteria are met)
   }
   \`\`\`

## Learnings

Check {learningsFile} for context on the implementer's decisions this iteration.

## Verdict

- **APPROVE** if all spec requirements are met and all required evidence is present
- **REJECT** for any clear issue: missing spec requirements, failing evidence, outdated library usage, security vulnerabilities, or CLAUDE.md violations

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches or rebase pushed commits
- Reject if you see any evidence of unsafe git operations`;
var DEFAULT_CHECKPOINTER_PROMPT = `# Checkpointer Task

## Context

The dev loop has failed to reach consensus after {iteration} iterations. Your task is to:

1. **Detect spec-level conflicts** that block progress \u2192 if found, exit with conflict status
2. **Auto-fix unambiguous spec mistakes** (like typos) \u2192 if fixed, continue loop with corrected spec
3. **Compress the spec** if no conflict AND progress > 60% \u2192 focus on remaining work

## Specification

Read the spec from: {specPath}

## Your Task

1. Read ALL reviews: current ({reviewsDir}/reviewer-*.md) and archived ({archivedReviewsPattern})
2. Analyze reviews against the spec to determine what criteria are complete vs remaining
3. Check for conflicts (see below)
4. Check for auto-fixable issues (e.g., typos) \u2014 ONLY if completely unambiguous

## What IS a Conflict

A conflict is a spec defect where **no possible implementation can satisfy all requirements simultaneously**, regardless of how intelligent or persistent the implementer is.

**The litmus test:** Imagine giving the implementer 10x intelligence and 10x more attempts. Could it eventually fulfil the spec? If the answer is NO, that is a conflict.

Conflicts are often subtle \u2014 the spec may look reasonable at a glance, but becomes impossible after implementation reveals ground truth:

- **Contradictory constraints**: Two or more acceptance criteria that cannot coexist. Example: "Do not modify any files in \`src/\`" combined with "Achieve 100% test coverage" \u2014 if \`src/\` contains dead code paths that are unreachable, the implementer cannot cover them without modifying \`src/\`. No amount of intelligence or retries solves this.
- **Circular dependencies**: Criterion A requires B done first, but B requires A done first.
- **Impossible environmental constraints**: Spec requires something the environment cannot provide (e.g., a file path that doesn't exist, a library version that lacks the specified API, a Node 14 requirement for a Node 18+ API).
- **Fundamentally ambiguous requirements**: Requirements so vague that reasonable implementers would produce fundamentally different solutions (e.g., "make it fast" with no metric, "improve UX" with no design spec).

**Important**: Reviewer disagreement \u2014 even across multiple loops \u2014 is NOT a conflict by itself. Use reviewer feedback as a clue for *where to look*, not as evidence of a conflict. Only flag a conflict if you can point to specific spec text that is self-contradictory or impossible to satisfy.

## What is NOT a Conflict

- **Reviewer disagreement**: Reviewers disagree on quality, approach, or interpretation \u2014 this is normal
- **Persistent reviewer rejection**: Even across many loops, this means the implementation needs more work
- **Incomplete implementation**: The implementer didn't finish, but the spec is achievable
- **Bugs or errors**: Implementation has bugs, but the spec is sound
- **Missing tests/evidence**: Implementation lacks proof, but the spec is achievable
- **Hard but possible**: The spec is difficult but achievable with enough effort

## Outcomes

### conflict_found
Spec has impossible/contradictory requirements.
- Write {conflictFile} with details
- Write checkpoint result to {checkpointResultFile} with \`"outcome": "conflict_found"\`

### spec_auto_fixed
Found an unambiguous mistake and fixed it.
- Edit {specPath} directly
- Write checkpoint result with \`"outcome": "spec_auto_fixed"\`

### spec_compressed
No conflict, no fix needed, progress > 60%.
- Compress spec to remaining work: remove completed items, keep partial/incomplete ones
- Update {specPath} with compressed spec
- Write checkpoint result with \`"outcome": "spec_compressed"\`

### no_action
No conflict, no fix, progress <= 60%.
- Write checkpoint result with \`"outcome": "no_action"\`

## Checkpoint Result JSON

Write to {checkpointResultFile}:
\`\`\`json
{
  "outcome": "conflict_found" | "spec_auto_fixed" | "spec_compressed" | "no_action",
  "summary": "Brief description",
  "progressPercent": 75,
  "completedCriteria": ["criterion 1"],
  "remainingCriteria": ["criterion 2"]
}
\`\`\`

If conflict_found, also write {conflictFile} with conflict analysis details.
If spec_auto_fixed or spec_compressed, edit {specPath} directly.`;
var CONFLICT_ONLY_CHECKPOINTER_PROMPT = `# Conflict Detection Task

## Context

The dev loop has failed to reach consensus after {iteration} iterations.
You are a **conflict detector** \u2014 your ONLY job is to determine if the spec itself is the problem.
You must NOT modify the spec. You must NOT compress the spec.

## Specification

Read the spec from: {specPath}

## Your Task

1. Read ALL reviews: current ({reviewsDir}/reviewer-*.md) and archived ({archivedReviewsPattern})
2. Read ALL verdicts from the review JSON files alongside the reviews
3. Cross-reference the spec's acceptance criteria / Definition of Done against every reviewer's findings
4. Determine if the spec contains a fundamental conflict that makes it impossible to implement

## What IS a Conflict

A conflict is a spec defect where **no possible implementation can satisfy all requirements simultaneously**, regardless of how intelligent or persistent the implementer is.

**The litmus test:** Imagine giving the implementer 10x intelligence and 10x more attempts. Could it eventually fulfil the spec? If the answer is NO, that is a conflict.

Conflicts are often subtle \u2014 the spec may look reasonable at a glance, but becomes impossible after implementation reveals ground truth:

- **Contradictory constraints**: Two or more acceptance criteria that cannot coexist. Example: "Do not modify any files in \`src/\`" combined with "Achieve 100% test coverage" \u2014 if \`src/\` contains dead code paths that are unreachable, the implementer cannot cover them without modifying \`src/\`. No amount of intelligence or retries solves this.
- **Circular dependencies**: Criterion A requires B done first, but B requires A done first.
- **Impossible environmental constraints**: Spec requires something the environment cannot provide (e.g., a file path that doesn't exist, a library version that lacks the specified API, a Node 14 requirement for a Node 18+ API).
- **Fundamentally ambiguous requirements**: Requirements so vague that reasonable implementers would produce fundamentally different solutions (e.g., "make it fast" with no metric, "improve UX" with no design spec).

**Important**: Reviewer disagreement \u2014 even across multiple loops \u2014 is NOT a conflict by itself. Use reviewer feedback as a clue for *where to look*, not as evidence of a conflict. Only flag a conflict if you can point to specific spec text that is self-contradictory or impossible to satisfy.

## What is NOT a Conflict

- **Reviewer disagreement**: Reviewers disagree on quality, approach, or interpretation \u2014 this is normal and expected
- **Persistent reviewer disagreement**: Even if reviewers keep rejecting across multiple loops, this only means the implementation needs more work, NOT that the spec is broken
- **Incomplete implementation**: The implementer didn't finish, but the spec is achievable
- **Bugs or errors**: Implementation has bugs, but the spec is sound
- **Missing tests/evidence**: Implementation lacks proof, but the spec is achievable
- **Style preferences**: Reviewers have different opinions on code style
- **Hard but possible**: The spec is difficult but achievable with enough effort

## Conflict Confidence Levels

When analyzing, assign a confidence level:

- **HIGH**: Found clear textual contradiction in the spec (quote both parts)
- **MEDIUM**: Cross-referencing reviews reveals systematic impossibility that isn't obvious from the spec alone
- **LOW**: Suspicion based on patterns but could be implementation issues

Only report conflicts at MEDIUM or higher confidence. If only LOW, report no_action.

## Outcomes

### conflict_found
The spec contains impossible, contradictory, or fundamentally ambiguous requirements.
- Write {conflictFile} with:
  1. The exact conflicting requirements (quote the spec)
  2. Why they conflict
  3. Which reviewers flagged this (with quotes)
  4. Suggested resolution (if obvious)
- Write checkpoint result to {checkpointResultFile} with \`"outcome": "conflict_found"\`

### no_action
No spec-level conflict detected. The spec is sound \u2014 failures are due to implementation/review issues.
- Write checkpoint result with \`"outcome": "no_action"\`
- Do NOT edit {specPath}

## Checkpoint Result JSON

Write to {checkpointResultFile}:
\`\`\`json
{
  "outcome": "conflict_found" | "no_action",
  "summary": "Brief description of what was found (or why no conflict)",
  "progressPercent": 75,
  "completedCriteria": ["criterion 1"],
  "remainingCriteria": ["criterion 2"],
  "conflictConfidence": "HIGH" | "MEDIUM" | "LOW"
}
\`\`\`

If conflict_found, also write {conflictFile} with detailed conflict analysis.
Do NOT edit {specPath} under any circumstances.`;

// src/agents/default-config.ts
function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split(
      `
`,
    )
    .map(line => pad + line).join(`
`);
}
function buildDefaultConfigYaml() {
  return `# kloop run configuration
implementers:
  claude: 1

reviewPhases:
  - - claude

conflictChecker: claude
maxIterations: 7
implementerTimeout: 30     # minutes
reviewerTimeout: 15        # minutes
conflictCheckThreshold: 3
compressSpec: false
firstLoopFullReview: true
previousReviewPropagation: 0.7

# Agent prompt templates \u2014 edit these to customize agent behavior.
# All {placeholders} are substituted at build time with actual runtime paths.
prompts:
  # implementer variables:
  #   {specPath}          - path to spec file (agent reads on demand)
  #   {iteration}         - current loop number
  #   {reviewsDir}        - path to reviews/ folder
  #   {evidenceDir}       - path to evidence/ folder
  #   {learningsFile}     - path to learnings.md
  implementer: |
${indent(DEFAULT_IMPLEMENTER_PROMPT, 4)}
  # reviewer variables:
  #   {specPath}        - path to spec file
  #   {iteration}       - current loop number
  #   {reviewerIndex}   - which reviewer this is
  #   {reviewsDir}      - path to reviews/ folder (write review here)
  #   {verdictsDir}     - path to verdicts/ folder (write verdict here)
  #   {evidenceDir}     - path to evidence/ folder
  #   {learningsFile}   - path to learnings.md
  reviewer: |
${indent(DEFAULT_REVIEWER_PROMPT, 4)}
  # checkpointer \u2014 used when compressSpec: false (conflict detection only, no spec modification)
  #   {specPath}               - path to spec file
  #   {iteration}              - current loop number
  #   {reviewsDir}             - path to current loop's reviews/
  #   {archivedReviewsPattern} - glob for all previous loop reviews
  #   {conflictFile}           - path to conflict.md
  #   {checkpointResultFile}  - path to checkpoint-result.json
  checkpointer: |
${indent(CONFLICT_ONLY_CHECKPOINTER_PROMPT, 4)}
  # checkpointerFull \u2014 used when compressSpec: true (conflict detection + spec compression + auto-fix)
  #   Same variables as checkpointer, plus:
  #   {specBackupFile}         - path to spec-backup.md (used during compression)
  checkpointerFull: |
${indent(DEFAULT_CHECKPOINTER_PROMPT, 4)}
`;
}

// src/cli/init.ts
async function handler(opts, _state, indexDb, eventLog) {
  try {
    const workspace = path2.resolve(opts.workspace ?? process.cwd());
    const kloopHome = getKloopHome();
    const existingRun = await indexDb.getRunByWorkspace(workspace);
    if (existingRun) {
      const runState = await eventLog.deriveStatus(existingRun.id);
      if (runState && !eventLog.isTerminal(runState.status)) {
        console.error(
          import_picocolors.default.red(`Error: Run ${existingRun.id} is still ${runState.status} in this workspace.`),
        );
        console.error(import_picocolors.default.dim('Cancel it first: kloop cancel'));
        process.exit(1);
      }
    }
    const runId = generateKloopRunId();
    const runDir = paths.runPath(runId);
    const defaultsPath = path2.join(kloopHome, 'config.yaml');
    await fs2.mkdir(kloopHome, { recursive: true });
    await fs2.mkdir(runDir, { recursive: true });
    let configContent;
    if (opts.config) {
      try {
        configContent = await fs2.readFile(path2.resolve(opts.config), 'utf-8');
      } catch {
        console.error(import_picocolors.default.red(`Error: Config file not found: ${opts.config}`));
        process.exit(1);
      }
    } else if (await fileExists(defaultsPath)) {
      configContent = await fs2.readFile(defaultsPath, 'utf-8');
    } else {
      configContent = buildDefaultConfigYaml();
      await fs2.writeFile(defaultsPath, configContent, 'utf-8');
      console.log(import_picocolors.default.dim(`  Created default config: ${defaultsPath}`));
    }
    await fs2.writeFile(paths.runConfig(runId), configContent, 'utf-8');
    let specContent = SPEC_TEMPLATE;
    if (opts.spec) {
      try {
        specContent = await fs2.readFile(path2.resolve(opts.spec), 'utf-8');
      } catch {
        console.error(import_picocolors.default.red(`Error: Spec file not found: ${opts.spec}`));
        process.exit(1);
      }
    }
    await fs2.writeFile(paths.runSpec(runId), specContent, 'utf-8');
    await fs2.writeFile(paths.runEvents(runId), '', 'utf-8');
    await fs2.writeFile(paths.runLearnings(runId), '', 'utf-8');
    await indexDb.insertRun({
      id: runId,
      workspace,
      started_at: new Date().toISOString(),
    });
    console.log(import_picocolors.default.bold('kloop Initialized'));
    console.log('');
    console.log(`  Run ID:     ${import_picocolors.default.green(runId)}`);
    console.log(`  Workspace:  ${workspace}`);
    console.log(`  Run dir:    ${runDir}`);
    console.log('');
    console.log(import_picocolors.default.dim('Next steps:'));
    console.log(
      import_picocolors.default.dim(`  1. kloop link ${runId}        # symlink spec+config into this project`),
    );
    console.log(import_picocolors.default.dim(`  2. kloop run ${runId}          # start the run`));
  } catch (err) {
    console.error(import_picocolors.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function fileExists(p) {
  try {
    await fs2.access(p);
    return true;
  } catch {
    return false;
  }
}

// src/cli/setup.ts
var import_picocolors2 = __toESM(require_picocolors(), 1);
import * as path3 from 'path';
import * as fs3 from 'fs/promises';
var DEFAULT_CONFIG_YAML = `# kloop default configuration
# This is used when no --config flag is provided to kloop init
implementers:
  claude: 1

reviewPhases:
  - - claude

maxIterations: 10
implementerTimeout: 30     # minutes
reviewerTimeout: 15        # minutes
conflictCheckThreshold: 2
firstLoopFullReview: false
previousReviewPropagation: 0
`;
async function handler2(opts) {
  try {
    const kloopHome = getKloopHome();
    const defaultsPath = path3.join(kloopHome, 'config.yaml');
    if (opts.config) {
      const srcPath = path3.resolve(opts.config);
      let content;
      try {
        content = await fs3.readFile(srcPath, 'utf-8');
      } catch {
        console.error(import_picocolors2.default.red(`Error: Config file not found: ${opts.config}`));
        process.exit(1);
      }
      await fs3.mkdir(kloopHome, { recursive: true });
      await fs3.writeFile(defaultsPath, content, 'utf-8');
      console.log(import_picocolors2.default.green(`Default config saved to ${defaultsPath}`));
      return;
    }
    if (await fileExists2(defaultsPath)) {
      const content = await fs3.readFile(defaultsPath, 'utf-8');
      console.log(import_picocolors2.default.bold('Current default config:'));
      console.log(import_picocolors2.default.dim(`  ${defaultsPath}`));
      console.log('');
      console.log(content);
    } else {
      await fs3.mkdir(kloopHome, { recursive: true });
      await fs3.writeFile(defaultsPath, DEFAULT_CONFIG_YAML, 'utf-8');
      console.log(import_picocolors2.default.green('Default config created:'));
      console.log(import_picocolors2.default.dim(`  ${defaultsPath}`));
      console.log('');
      console.log('Edit this file to change defaults for future kloop init runs.');
    }
  } catch (err) {
    console.error(import_picocolors2.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function fileExists2(p) {
  try {
    await fs3.access(p);
    return true;
  } catch {
    return false;
  }
}

// src/cli/run.ts
var import_picocolors4 = __toESM(require_picocolors(), 1);
import * as path7 from 'path';

// src/loop/runner.ts
import * as fs5 from 'fs/promises';
import * as path5 from 'path';

// node_modules/zod/v3/external.js
var exports_external = {};
__export(exports_external, {
  void: () => voidType,
  util: () => util,
  unknown: () => unknownType,
  union: () => unionType,
  undefined: () => undefinedType,
  tuple: () => tupleType,
  transformer: () => effectsType,
  symbol: () => symbolType,
  string: () => stringType,
  strictObject: () => strictObjectType,
  setErrorMap: () => setErrorMap,
  set: () => setType,
  record: () => recordType,
  quotelessJson: () => quotelessJson,
  promise: () => promiseType,
  preprocess: () => preprocessType,
  pipeline: () => pipelineType,
  ostring: () => ostring,
  optional: () => optionalType,
  onumber: () => onumber,
  oboolean: () => oboolean,
  objectUtil: () => objectUtil,
  object: () => objectType,
  number: () => numberType,
  nullable: () => nullableType,
  null: () => nullType,
  never: () => neverType,
  nativeEnum: () => nativeEnumType,
  nan: () => nanType,
  map: () => mapType,
  makeIssue: () => makeIssue,
  literal: () => literalType,
  lazy: () => lazyType,
  late: () => late,
  isValid: () => isValid,
  isDirty: () => isDirty,
  isAsync: () => isAsync,
  isAborted: () => isAborted,
  intersection: () => intersectionType,
  instanceof: () => instanceOfType,
  getParsedType: () => getParsedType,
  getErrorMap: () => getErrorMap,
  function: () => functionType,
  enum: () => enumType,
  effect: () => effectsType,
  discriminatedUnion: () => discriminatedUnionType,
  defaultErrorMap: () => en_default,
  datetimeRegex: () => datetimeRegex,
  date: () => dateType,
  custom: () => custom,
  coerce: () => coerce,
  boolean: () => booleanType,
  bigint: () => bigIntType,
  array: () => arrayType,
  any: () => anyType,
  addIssueToContext: () => addIssueToContext,
  ZodVoid: () => ZodVoid,
  ZodUnknown: () => ZodUnknown,
  ZodUnion: () => ZodUnion,
  ZodUndefined: () => ZodUndefined,
  ZodType: () => ZodType,
  ZodTuple: () => ZodTuple,
  ZodTransformer: () => ZodEffects,
  ZodSymbol: () => ZodSymbol,
  ZodString: () => ZodString,
  ZodSet: () => ZodSet,
  ZodSchema: () => ZodType,
  ZodRecord: () => ZodRecord,
  ZodReadonly: () => ZodReadonly,
  ZodPromise: () => ZodPromise,
  ZodPipeline: () => ZodPipeline,
  ZodParsedType: () => ZodParsedType,
  ZodOptional: () => ZodOptional,
  ZodObject: () => ZodObject,
  ZodNumber: () => ZodNumber,
  ZodNullable: () => ZodNullable,
  ZodNull: () => ZodNull,
  ZodNever: () => ZodNever,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNaN: () => ZodNaN,
  ZodMap: () => ZodMap,
  ZodLiteral: () => ZodLiteral,
  ZodLazy: () => ZodLazy,
  ZodIssueCode: () => ZodIssueCode,
  ZodIntersection: () => ZodIntersection,
  ZodFunction: () => ZodFunction,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodError: () => ZodError,
  ZodEnum: () => ZodEnum,
  ZodEffects: () => ZodEffects,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodDefault: () => ZodDefault,
  ZodDate: () => ZodDate,
  ZodCatch: () => ZodCatch,
  ZodBranded: () => ZodBranded,
  ZodBoolean: () => ZodBoolean,
  ZodBigInt: () => ZodBigInt,
  ZodArray: () => ZodArray,
  ZodAny: () => ZodAny,
  Schema: () => ZodType,
  ParseStatus: () => ParseStatus,
  OK: () => OK,
  NEVER: () => NEVER,
  INVALID: () => INVALID,
  EMPTY_PATH: () => EMPTY_PATH,
  DIRTY: () => DIRTY,
  BRAND: () => BRAND,
});

// node_modules/zod/v3/helpers/util.js
var util;
(function (util2) {
  util2.assertEqual = _ => {};
  function assertIs(_arg) {}
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = items => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = obj => {
    const validKeys = util2.objectKeys(obj).filter(k => typeof obj[obj[k]] !== 'number');
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = obj => {
    return util2.objectKeys(obj).map(function (e) {
      return obj[e];
    });
  };
  util2.objectKeys =
    typeof Object.keys === 'function'
      ? obj => Object.keys(obj)
      : object => {
          const keys = [];
          for (const key in object) {
            if (Object.prototype.hasOwnProperty.call(object, key)) {
              keys.push(key);
            }
          }
          return keys;
        };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item)) return item;
    }
    return;
  };
  util2.isInteger =
    typeof Number.isInteger === 'function'
      ? val => Number.isInteger(val)
      : val => typeof val === 'number' && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = ' | ') {
    return array.map(val => (typeof val === 'string' ? `'${val}'` : val)).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function (objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second,
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  'string',
  'nan',
  'number',
  'integer',
  'float',
  'boolean',
  'date',
  'bigint',
  'symbol',
  'function',
  'undefined',
  'null',
  'array',
  'object',
  'unknown',
  'promise',
  'void',
  'never',
  'map',
  'set',
]);
var getParsedType = data => {
  const t = typeof data;
  switch (t) {
    case 'undefined':
      return ZodParsedType.undefined;
    case 'string':
      return ZodParsedType.string;
    case 'number':
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case 'boolean':
      return ZodParsedType.boolean;
    case 'function':
      return ZodParsedType.function;
    case 'bigint':
      return ZodParsedType.bigint;
    case 'symbol':
      return ZodParsedType.symbol;
    case 'object':
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === 'function' && data.catch && typeof data.catch === 'function') {
        return ZodParsedType.promise;
      }
      if (typeof Map !== 'undefined' && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== 'undefined' && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== 'undefined' && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  'invalid_type',
  'invalid_literal',
  'custom',
  'invalid_union',
  'invalid_union_discriminator',
  'invalid_enum_value',
  'unrecognized_keys',
  'invalid_arguments',
  'invalid_return_type',
  'invalid_date',
  'invalid_string',
  'too_small',
  'too_big',
  'invalid_intersection_types',
  'not_multiple_of',
  'not_finite',
]);
var quotelessJson = obj => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, '$1:');
};

class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = sub => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = 'ZodError';
    this.issues = issues;
  }
  format(_mapper) {
    const mapper =
      _mapper ||
      function (issue) {
        return issue.message;
      };
    const fieldErrors = { _errors: [] };
    const processError = error => {
      for (const issue of error.issues) {
        if (issue.code === 'invalid_union') {
          issue.unionErrors.map(processError);
        } else if (issue.code === 'invalid_return_type') {
          processError(issue.returnTypeError);
        } else if (issue.code === 'invalid_arguments') {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = issue => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = issues => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = 'Required';
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ', ')}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === 'object') {
        if ('includes' in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === 'number') {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ('startsWith' in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ('endsWith' in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== 'regex') {
        message = `Invalid ${issue.validation}`;
      } else {
        message = 'Invalid';
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === 'array')
        message = `Array must contain ${issue.exact ? 'exactly' : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === 'string')
        message = `String must contain ${issue.exact ? 'exactly' : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === 'number')
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === 'bigint')
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === 'date')
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else message = 'Invalid input';
      break;
    case ZodIssueCode.too_big:
      if (issue.type === 'array')
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === 'string')
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === 'number')
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === 'bigint')
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === 'date')
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else message = 'Invalid input';
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = 'Number must be finite';
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = params => {
  const { data, path: path4, errorMaps, issueData } = params;
  const fullPath = [...path4, ...(issueData.path || [])];
  const fullIssue = {
    ...issueData,
    path: fullPath,
  };
  if (issueData.message !== undefined) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message,
    };
  }
  let errorMessage = '';
  const maps = errorMaps
    .filter(m => !!m)
    .slice()
    .reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage,
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default ? undefined : en_default,
    ].filter(x => !!x),
  });
  ctx.common.issues.push(issue);
}

class ParseStatus {
  constructor() {
    this.value = 'valid';
  }
  dirty() {
    if (this.value === 'valid') this.value = 'dirty';
  }
  abort() {
    if (this.value !== 'aborted') this.value = 'aborted';
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === 'aborted') return INVALID;
      if (s.status === 'dirty') status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value,
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === 'aborted') return INVALID;
      if (value.status === 'aborted') return INVALID;
      if (key.status === 'dirty') status.dirty();
      if (value.status === 'dirty') status.dirty();
      if (key.value !== '__proto__' && (typeof value.value !== 'undefined' || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
var INVALID = Object.freeze({
  status: 'aborted',
});
var DIRTY = value => ({ status: 'dirty', value });
var OK = value => ({ status: 'valid', value });
var isAborted = x => x.status === 'aborted';
var isDirty = x => x.status === 'dirty';
var isValid = x => x.status === 'valid';
var isAsync = x => typeof Promise !== 'undefined' && x instanceof Promise;
// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function (errorUtil2) {
  errorUtil2.errToObj = message => (typeof message === 'string' ? { message } : message || {});
  errorUtil2.toString = message => (typeof message === 'string' ? message : message?.message);
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path4, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path4;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error('Validation failed but no issues detected.');
    }
    return {
      success: false,
      get error() {
        if (this._error) return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      },
    };
  }
};
function processCreateParams(params) {
  if (!params) return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2) return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === 'invalid_enum_value') {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === 'undefined') {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== 'invalid_type') return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}

class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return (
      ctx || {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent,
      }
    );
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent,
      },
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error('Synchronous parse encountered promise.');
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap,
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data),
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  '~validate'(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this['~standard'].async,
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data),
    };
    if (!this['~standard'].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result)
          ? {
              value: result.value,
            }
          : {
              issues: ctx.common.issues,
            };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes('encountered')) {
          this['~standard'].async = true;
        }
        ctx.common = {
          issues: [],
          async: true,
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then(result =>
      isValid(result)
        ? {
            value: result.value,
          }
        : {
            issues: ctx.common.issues,
          },
    );
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success) return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true,
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data),
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = val => {
      if (typeof message === 'string' || typeof message === 'undefined') {
        return { message };
      } else if (typeof message === 'function') {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () =>
        ctx.addIssue({
          code: ZodIssueCode.custom,
          ...getIssueProperties(val),
        });
      if (typeof Promise !== 'undefined' && result instanceof Promise) {
        return result.then(data => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === 'function' ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: 'refinement', refinement },
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this['~standard'] = {
      version: 1,
      vendor: 'zod',
      validate: data => this['~validate'](data),
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: 'transform', transform },
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === 'function' ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault,
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def),
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === 'function' ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch,
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description,
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(undefined).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex =
  /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? '+' : '?';
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset) opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join('|')})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === 'v4' || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === 'v6' || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt)) return false;
  try {
    const [header] = jwt.split('.');
    if (!header) return false;
    const base64 = header
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(header.length + ((4 - (header.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== 'object' || decoded === null) return false;
    if ('typ' in decoded && decoded?.typ !== 'JWT') return false;
    if (!decoded.alg) return false;
    if (alg && decoded.alg !== alg) return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === 'v4' || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === 'v6' || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}

class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType,
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === 'min') {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: 'string',
            inclusive: true,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: 'string',
            inclusive: true,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'length') {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: 'string',
              inclusive: true,
              exact: true,
              message: check.message,
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: 'string',
              inclusive: true,
              exact: true,
              message: check.message,
            });
          }
          status.dirty();
        }
      } else if (check.kind === 'email') {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'email',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'emoji') {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, 'u');
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'emoji',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'uuid') {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'uuid',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'nanoid') {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'nanoid',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'cuid') {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'cuid',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'cuid2') {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'cuid2',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'ulid') {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'ulid',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'url') {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'url',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'regex') {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'regex',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'trim') {
        input.data = input.data.trim();
      } else if (check.kind === 'includes') {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'toLowerCase') {
        input.data = input.data.toLowerCase();
      } else if (check.kind === 'toUpperCase') {
        input.data = input.data.toUpperCase();
      } else if (check.kind === 'startsWith') {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'endsWith') {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'datetime') {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: 'datetime',
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'date') {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: 'date',
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'time') {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: 'time',
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'duration') {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'duration',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'ip') {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'ip',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'jwt') {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'jwt',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'cidr') {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'cidr',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'base64') {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'base64',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'base64url') {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: 'base64url',
            code: ZodIssueCode.invalid_string,
            message: check.message,
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement(data => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message),
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  email(message) {
    return this._addCheck({ kind: 'email', ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: 'url', ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: 'emoji', ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: 'uuid', ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: 'nanoid', ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: 'cuid', ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: 'cuid2', ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: 'ulid', ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: 'base64', ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: 'base64url',
      ...errorUtil.errToObj(message),
    });
  }
  jwt(options) {
    return this._addCheck({ kind: 'jwt', ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: 'ip', ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: 'cidr', ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === 'string') {
      return this._addCheck({
        kind: 'datetime',
        precision: null,
        offset: false,
        local: false,
        message: options,
      });
    }
    return this._addCheck({
      kind: 'datetime',
      precision: typeof options?.precision === 'undefined' ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message),
    });
  }
  date(message) {
    return this._addCheck({ kind: 'date', message });
  }
  time(options) {
    if (typeof options === 'string') {
      return this._addCheck({
        kind: 'time',
        precision: null,
        message: options,
      });
    }
    return this._addCheck({
      kind: 'time',
      precision: typeof options?.precision === 'undefined' ? null : options?.precision,
      ...errorUtil.errToObj(options?.message),
    });
  }
  duration(message) {
    return this._addCheck({ kind: 'duration', ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: 'regex',
      regex,
      ...errorUtil.errToObj(message),
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: 'includes',
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message),
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: 'startsWith',
      value,
      ...errorUtil.errToObj(message),
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: 'endsWith',
      value,
      ...errorUtil.errToObj(message),
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: 'min',
      value: minLength,
      ...errorUtil.errToObj(message),
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: 'max',
      value: maxLength,
      ...errorUtil.errToObj(message),
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: 'length',
      value: len,
      ...errorUtil.errToObj(message),
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: 'trim' }],
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: 'toLowerCase' }],
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: 'toUpperCase' }],
    });
  }
  get isDatetime() {
    return !!this._def.checks.find(ch => ch.kind === 'datetime');
  }
  get isDate() {
    return !!this._def.checks.find(ch => ch.kind === 'date');
  }
  get isTime() {
    return !!this._def.checks.find(ch => ch.kind === 'time');
  }
  get isDuration() {
    return !!this._def.checks.find(ch => ch.kind === 'duration');
  }
  get isEmail() {
    return !!this._def.checks.find(ch => ch.kind === 'email');
  }
  get isURL() {
    return !!this._def.checks.find(ch => ch.kind === 'url');
  }
  get isEmoji() {
    return !!this._def.checks.find(ch => ch.kind === 'emoji');
  }
  get isUUID() {
    return !!this._def.checks.find(ch => ch.kind === 'uuid');
  }
  get isNANOID() {
    return !!this._def.checks.find(ch => ch.kind === 'nanoid');
  }
  get isCUID() {
    return !!this._def.checks.find(ch => ch.kind === 'cuid');
  }
  get isCUID2() {
    return !!this._def.checks.find(ch => ch.kind === 'cuid2');
  }
  get isULID() {
    return !!this._def.checks.find(ch => ch.kind === 'ulid');
  }
  get isIP() {
    return !!this._def.checks.find(ch => ch.kind === 'ip');
  }
  get isCIDR() {
    return !!this._def.checks.find(ch => ch.kind === 'cidr');
  }
  get isBase64() {
    return !!this._def.checks.find(ch => ch.kind === 'base64');
  }
  get isBase64url() {
    return !!this._def.checks.find(ch => ch.kind === 'base64url');
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = params => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params),
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split('.')[1] || '').length;
  const stepDecCount = (step.toString().split('.')[1] || '').length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace('.', ''));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace('.', ''));
  return (valInt % stepInt) / 10 ** decCount;
}

class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType,
      });
      return INVALID;
    }
    let ctx = undefined;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === 'int') {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: 'integer',
            received: 'float',
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'min') {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: 'number',
            inclusive: check.inclusive,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: 'number',
            inclusive: check.inclusive,
            exact: false,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'multipleOf') {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'finite') {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message,
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit('min', value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit('min', value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit('max', value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit('max', value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message),
        },
      ],
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  int(message) {
    return this._addCheck({
      kind: 'int',
      message: errorUtil.toString(message),
    });
  }
  positive(message) {
    return this._addCheck({
      kind: 'min',
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  negative(message) {
    return this._addCheck({
      kind: 'max',
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: 'max',
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: 'min',
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: 'multipleOf',
      value,
      message: errorUtil.toString(message),
    });
  }
  finite(message) {
    return this._addCheck({
      kind: 'finite',
      message: errorUtil.toString(message),
    });
  }
  safe(message) {
    return this._addCheck({
      kind: 'min',
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message),
    })._addCheck({
      kind: 'max',
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message),
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find(ch => ch.kind === 'int' || (ch.kind === 'multipleOf' && util.isInteger(ch.value)));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'finite' || ch.kind === 'int' || ch.kind === 'multipleOf') {
        return true;
      } else if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      } else if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = params => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params),
  });
};

class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = undefined;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === 'min') {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: 'bigint',
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: 'bigint',
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message,
          });
          status.dirty();
        }
      } else if (check.kind === 'multipleOf') {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message,
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType,
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit('min', value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit('min', value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit('max', value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit('max', value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message),
        },
      ],
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  positive(message) {
    return this._addCheck({
      kind: 'min',
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  negative(message) {
    return this._addCheck({
      kind: 'max',
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message),
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: 'max',
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: 'min',
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message),
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: 'multipleOf',
      value,
      message: errorUtil.toString(message),
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = params => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params),
  });
};

class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = params => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params),
  });
};

class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType,
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date,
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === 'min') {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: 'date',
          });
          status.dirty();
        }
      } else if (check.kind === 'max') {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: 'date',
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime()),
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check],
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: 'min',
      value: minDate.getTime(),
      message: errorUtil.toString(message),
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: 'max',
      value: maxDate.getTime(),
      message: errorUtil.toString(message),
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'min') {
        if (min === null || ch.value > min) min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === 'max') {
        if (max === null || ch.value < max) max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = params => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params),
  });
};

class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = params => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params),
  });
};

class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = params => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params),
  });
};

class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = params => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params),
  });
};

class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = params => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params),
  });
};

class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = params => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params),
  });
};

class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType,
    });
    return INVALID;
  }
}
ZodNever.create = params => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params),
  });
};

class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = params => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params),
  });
};

class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : undefined,
          maximum: tooBig ? def.exactLength.value : undefined,
          type: 'array',
          inclusive: true,
          exact: true,
          message: def.exactLength.message,
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: 'array',
          inclusive: true,
          exact: false,
          message: def.minLength.message,
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: 'array',
          inclusive: true,
          exact: false,
          message: def.maxLength.message,
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all(
        [...ctx.data].map((item, i) => {
          return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        }),
      ).then(result2 => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) },
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) },
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) },
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params),
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape,
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element),
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map(item => deepPartialify(item)));
  } else {
    return schema;
  }
}

class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType,
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === 'strip')) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: 'valid', value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data,
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === 'passthrough') {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: 'valid', value: key },
            value: { status: 'valid', value: ctx.data[key] },
          });
        }
      } else if (unknownKeys === 'strict') {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys,
          });
          status.dirty();
        }
      } else if (unknownKeys === 'strip') {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: 'valid', value: key },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data,
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve()
        .then(async () => {
          const syncPairs = [];
          for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
              key,
              value,
              alwaysSet: pair.alwaysSet,
            });
          }
          return syncPairs;
        })
        .then(syncPairs => {
          return ParseStatus.mergeObjectSync(status, syncPairs);
        });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: 'strict',
      ...(message !== undefined
        ? {
            errorMap: (issue, ctx) => {
              const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
              if (issue.code === 'unrecognized_keys')
                return {
                  message: errorUtil.errToObj(message).message ?? defaultError,
                };
              return {
                message: defaultError,
              };
            },
          }
        : {}),
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: 'strip',
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: 'passthrough',
    });
  }
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation,
      }),
    });
  }
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape(),
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject,
    });
    return merged;
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index,
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape,
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape,
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape,
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape,
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: 'strip',
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params),
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: 'strict',
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params),
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: 'strip',
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params),
  });
};

class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === 'valid') {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === 'dirty') {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map(result => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors,
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(
        options.map(async option => {
          const childCtx = {
            ...ctx,
            common: {
              ...ctx.common,
              issues: [],
            },
            parent: null,
          };
          return {
            result: await option._parseAsync({
              data: ctx.data,
              path: ctx.path,
              parent: childCtx,
            }),
            ctx: childCtx,
          };
        }),
      ).then(handleResults);
    } else {
      let dirty = undefined;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: [],
          },
          parent: null,
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx,
        });
        if (result.status === 'valid') {
          return result;
        } else if (result.status === 'dirty' && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map(issues2 => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors,
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params),
  });
};
var getDiscriminator = type => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [undefined];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [undefined, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};

class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator],
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx,
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx,
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(
          `A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`,
        );
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params),
    });
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter(key => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}

class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types,
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(
        this._def.left._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
        this._def.right._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        }),
      );
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params),
  });
};

class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: 'array',
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: 'array',
      });
      status.dirty();
    }
    const items = [...ctx.data]
      .map((item, itemIndex) => {
        const schema = this._def.items[itemIndex] || this._def.rest;
        if (!schema) return null;
        return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
      })
      .filter(x => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then(results => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest,
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error('You must pass an array of schemas to z.tuple([ ... ])');
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params),
  });
};

class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data,
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third),
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second),
    });
  }
}

class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, 'key'])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, 'value'])),
      };
    });
    if (ctx.common.async) {
      const finalMap = new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === 'aborted' || value.status === 'aborted') {
            return INVALID;
          }
          if (key.status === 'dirty' || value.status === 'dirty') {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === 'aborted' || value.status === 'aborted') {
          return INVALID;
        }
        if (key.status === 'dirty' || value.status === 'dirty') {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params),
  });
};

class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: 'set',
          inclusive: true,
          exact: false,
          message: def.minSize.message,
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: 'set',
          inclusive: true,
          exact: false,
          message: def.maxSize.message,
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = new Set();
      for (const element of elements2) {
        if (element.status === 'aborted') return INVALID;
        if (element.status === 'dirty') status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) =>
      valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)),
    );
    if (ctx.common.async) {
      return Promise.all(elements).then(elements2 => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) },
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) },
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params),
  });
};

class ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter(x => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error,
        },
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter(x => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error,
        },
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function (...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch(e => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch(e => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function (...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create()),
    });
  }
  returns(returnType) {
    return new ZodFunction({
      ...this._def,
      returns: returnType,
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params),
    });
  }
}

class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params),
  });
};

class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value,
      });
      return INVALID;
    }
    return { status: 'valid', value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params),
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params),
  });
}

class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== 'string') {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type,
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues,
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef,
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(
      this.options.filter(opt => !values.includes(opt)),
      {
        ...this._def,
        ...newDef,
      },
    );
  }
}
ZodEnum.create = createZodEnum;

class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type,
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues,
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params),
  });
};

class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(
      promisified.then(data => {
        return this._def.type.parseAsync(data, {
          path: ctx.path,
          errorMap: ctx.common.contextualErrorMap,
        });
      }),
    );
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params),
  });
};

class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
      ? this._def.schema.sourceType()
      : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: arg => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      },
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === 'preprocess') {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async processed2 => {
          if (status.value === 'aborted') return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx,
          });
          if (result.status === 'aborted') return INVALID;
          if (result.status === 'dirty') return DIRTY(result.value);
          if (status.value === 'dirty') return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === 'aborted') return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx,
        });
        if (result.status === 'aborted') return INVALID;
        if (result.status === 'dirty') return DIRTY(result.value);
        if (status.value === 'dirty') return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === 'refinement') {
      const executeRefinement = acc => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error('Async refinement encountered during synchronous parse operation. Use .parseAsync instead.');
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        });
        if (inner.status === 'aborted') return INVALID;
        if (inner.status === 'dirty') status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then(inner => {
          if (inner.status === 'aborted') return INVALID;
          if (inner.status === 'dirty') status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === 'transform') {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        });
        if (!isValid(base)) return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(
            `Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`,
          );
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then(base => {
          if (!isValid(base)) return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then(result => ({
            status: status.value,
            value: result,
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params),
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: 'preprocess', transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params),
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(undefined);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params),
  });
};

class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params),
  });
};

class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx,
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === 'function' ? params.default : () => params.default,
    ...processCreateParams(params),
  });
};

class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: [],
      },
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx,
      },
    });
    if (isAsync(result)) {
      return result.then(result2 => {
        return {
          status: 'valid',
          value:
            result2.status === 'valid'
              ? result2.value
              : this._def.catchValue({
                  get error() {
                    return new ZodError(newCtx.common.issues);
                  },
                  input: newCtx.data,
                }),
        };
      });
    } else {
      return {
        status: 'valid',
        value:
          result.status === 'valid'
            ? result.value
            : this._def.catchValue({
                get error() {
                  return new ZodError(newCtx.common.issues);
                },
                input: newCtx.data,
              }),
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === 'function' ? params.catch : () => params.catch,
    ...processCreateParams(params),
  });
};

class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType,
      });
      return INVALID;
    }
    return { status: 'valid', value: input.data };
  }
}
ZodNaN.create = params => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params),
  });
};
var BRAND = Symbol('zod_brand');

class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx,
    });
  }
  unwrap() {
    return this._def.type;
  }
}

class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx,
        });
        if (inResult.status === 'aborted') return INVALID;
        if (inResult.status === 'dirty') {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx,
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx,
      });
      if (inResult.status === 'aborted') return INVALID;
      if (inResult.status === 'dirty') {
        status.dirty();
        return {
          status: 'dirty',
          value: inResult.value,
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx,
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline,
    });
  }
}

class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = data => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then(data => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params),
  });
};
function cleanParams(params, data) {
  const p = typeof params === 'function' ? params(data) : typeof params === 'string' ? { message: params } : params;
  const p2 = typeof p === 'string' ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then(r2 => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: 'custom', ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: 'custom', ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate,
};
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2['ZodString'] = 'ZodString';
  ZodFirstPartyTypeKind2['ZodNumber'] = 'ZodNumber';
  ZodFirstPartyTypeKind2['ZodNaN'] = 'ZodNaN';
  ZodFirstPartyTypeKind2['ZodBigInt'] = 'ZodBigInt';
  ZodFirstPartyTypeKind2['ZodBoolean'] = 'ZodBoolean';
  ZodFirstPartyTypeKind2['ZodDate'] = 'ZodDate';
  ZodFirstPartyTypeKind2['ZodSymbol'] = 'ZodSymbol';
  ZodFirstPartyTypeKind2['ZodUndefined'] = 'ZodUndefined';
  ZodFirstPartyTypeKind2['ZodNull'] = 'ZodNull';
  ZodFirstPartyTypeKind2['ZodAny'] = 'ZodAny';
  ZodFirstPartyTypeKind2['ZodUnknown'] = 'ZodUnknown';
  ZodFirstPartyTypeKind2['ZodNever'] = 'ZodNever';
  ZodFirstPartyTypeKind2['ZodVoid'] = 'ZodVoid';
  ZodFirstPartyTypeKind2['ZodArray'] = 'ZodArray';
  ZodFirstPartyTypeKind2['ZodObject'] = 'ZodObject';
  ZodFirstPartyTypeKind2['ZodUnion'] = 'ZodUnion';
  ZodFirstPartyTypeKind2['ZodDiscriminatedUnion'] = 'ZodDiscriminatedUnion';
  ZodFirstPartyTypeKind2['ZodIntersection'] = 'ZodIntersection';
  ZodFirstPartyTypeKind2['ZodTuple'] = 'ZodTuple';
  ZodFirstPartyTypeKind2['ZodRecord'] = 'ZodRecord';
  ZodFirstPartyTypeKind2['ZodMap'] = 'ZodMap';
  ZodFirstPartyTypeKind2['ZodSet'] = 'ZodSet';
  ZodFirstPartyTypeKind2['ZodFunction'] = 'ZodFunction';
  ZodFirstPartyTypeKind2['ZodLazy'] = 'ZodLazy';
  ZodFirstPartyTypeKind2['ZodLiteral'] = 'ZodLiteral';
  ZodFirstPartyTypeKind2['ZodEnum'] = 'ZodEnum';
  ZodFirstPartyTypeKind2['ZodEffects'] = 'ZodEffects';
  ZodFirstPartyTypeKind2['ZodNativeEnum'] = 'ZodNativeEnum';
  ZodFirstPartyTypeKind2['ZodOptional'] = 'ZodOptional';
  ZodFirstPartyTypeKind2['ZodNullable'] = 'ZodNullable';
  ZodFirstPartyTypeKind2['ZodDefault'] = 'ZodDefault';
  ZodFirstPartyTypeKind2['ZodCatch'] = 'ZodCatch';
  ZodFirstPartyTypeKind2['ZodPromise'] = 'ZodPromise';
  ZodFirstPartyTypeKind2['ZodBranded'] = 'ZodBranded';
  ZodFirstPartyTypeKind2['ZodPipeline'] = 'ZodPipeline';
  ZodFirstPartyTypeKind2['ZodReadonly'] = 'ZodReadonly';
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (
  cls,
  params = {
    message: `Input not instance of ${cls.name}`,
  },
) => custom(data => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: arg => ZodString.create({ ...arg, coerce: true }),
  number: arg => ZodNumber.create({ ...arg, coerce: true }),
  boolean: arg =>
    ZodBoolean.create({
      ...arg,
      coerce: true,
    }),
  bigint: arg => ZodBigInt.create({ ...arg, coerce: true }),
  date: arg => ZodDate.create({ ...arg, coerce: true }),
};
var NEVER = INVALID;
// src/types.ts
var metricSampleSchema = exports_external.object({
  labels: exports_external.record(exports_external.string(), exports_external.string()),
  durationMs: exports_external.number().nonnegative(),
  inputTokens: exports_external.number().int().nonnegative().optional(),
  outputTokens: exports_external.number().int().nonnegative().optional(),
  error: exports_external.string().optional(),
});
var configSchema = exports_external
  .object({
    implementers: exports_external
      .record(exports_external.string(), exports_external.number().int().positive())
      .optional(),
    implementer: exports_external.string().min(1).optional(),
    reviewPhases: exports_external.array(exports_external.array(exports_external.string().min(1)).min(1)).optional(),
    reviewers: exports_external.array(exports_external.string().min(1)).optional(),
    conflictChecker: exports_external.string().min(1).optional(),
    maxIterations: exports_external.number().min(1).max(100).default(7),
    implementerTimeout: exports_external.number().min(0.001).max(120).default(30),
    reviewerTimeout: exports_external.number().min(0.001).max(120).default(15),
    conflictCheckThreshold: exports_external.number().min(1).max(100).default(3),
    compressSpec: exports_external.boolean().default(false),
    firstLoopFullReview: exports_external.boolean().default(true),
    previousReviewPropagation: exports_external.number().min(0).max(1).default(0.7),
    prompts: exports_external
      .object({
        implementer: exports_external.string().optional(),
        reviewer: exports_external.string().optional(),
        checkpointer: exports_external.string().optional(),
        checkpointerFull: exports_external.string().optional(),
      })
      .optional(),
  })
  .transform(data => {
    let implementers = data.implementers;
    if (!implementers && data.implementer) {
      implementers = { [data.implementer]: 1 };
    } else if (data.implementer && implementers && !(data.implementer in implementers)) {
      implementers = { ...implementers, [data.implementer]: 1 };
    }
    if (!implementers) {
      implementers = { claude: 1 };
    }
    let reviewPhases = data.reviewPhases;
    if (!reviewPhases && data.reviewers && data.reviewers.length > 0) {
      reviewPhases = [data.reviewers];
    }
    if (!reviewPhases) {
      reviewPhases = [['claude-reviewer-zai']];
    }
    return {
      implementers,
      reviewPhases,
      conflictChecker: data.conflictChecker,
      maxIterations: data.maxIterations,
      implementerTimeout: data.implementerTimeout,
      reviewerTimeout: data.reviewerTimeout,
      conflictCheckThreshold: data.conflictCheckThreshold,
      compressSpec: data.compressSpec,
      firstLoopFullReview: data.firstLoopFullReview,
      previousReviewPropagation: data.previousReviewPropagation,
      prompts: data.prompts,
    };
  });
var resolvedConfigSchema = exports_external.object({
  implementers: exports_external.record(exports_external.string(), exports_external.number().int().positive()),
  reviewPhases: exports_external.array(exports_external.array(exports_external.string().min(1))).min(1),
  conflictChecker: exports_external.string().min(1).optional(),
  maxIterations: exports_external.number().min(1).max(100),
  implementerTimeout: exports_external.number().min(0.001).max(120),
  reviewerTimeout: exports_external.number().min(0.001).max(120),
  conflictCheckThreshold: exports_external.number().min(1).max(100),
  compressSpec: exports_external.boolean(),
  firstLoopFullReview: exports_external.boolean(),
  previousReviewPropagation: exports_external.number().min(0).max(1),
  prompts: exports_external
    .object({
      implementer: exports_external.string().optional(),
      reviewer: exports_external.string().optional(),
      checkpointer: exports_external.string().optional(),
      checkpointerFull: exports_external.string().optional(),
    })
    .optional(),
});
var runStatusSchema = exports_external.enum(['running', 'completed', 'cancelled', 'failed', 'conflict']);
var phaseSchema = exports_external.enum(['implementing', 'reviewing', 'done']);
var agentRoleSchema = exports_external.enum(['implementer', 'reviewer', 'checkpointer']);
var sessionStatusSchema = exports_external.enum(['running', 'completed', 'error']);
var verdictSchema = exports_external.enum(['approved', 'rejected']);
var runSchema = exports_external.object({
  id: exports_external.string().min(1),
  spec: exports_external.string(),
  status: runStatusSchema,
  iteration: exports_external.number().int().nonnegative(),
  phase: phaseSchema,
  startedAt: exports_external.string().datetime(),
  learnings: exports_external.array(exports_external.string()).default([]),
  consecutiveFailures: exports_external.number().int().nonnegative().default(0),
});
var sessionSchema = exports_external.object({
  id: exports_external.string().min(1),
  iteration: exports_external.number().int().positive(),
  role: agentRoleSchema,
  reviewerIndex: exports_external.number().int().nonnegative().optional(),
  binary: exports_external.string().optional(),
  tmuxSession: exports_external.string(),
  status: sessionStatusSchema,
  verdict: verdictSchema.optional(),
  startedAt: exports_external.string().datetime(),
  completedAt: exports_external.string().datetime().optional(),
  harnessSessionId: exports_external.string().optional(),
});
var verdictFileSchema = exports_external.object({
  approved: exports_external.boolean(),
  reasoning: exports_external.string(),
  completionEstimate: exports_external.number().int().min(0).max(100).optional(),
});
var sessionSummarySchema = exports_external.object({
  role: agentRoleSchema,
  reviewerIndex: exports_external.number().int().nonnegative().optional(),
});
var iterationSummarySchema = exports_external.object({
  iteration: exports_external.number().int().positive(),
  implementerDuration: exports_external.number().nonnegative().optional(),
  reviewerVerdicts: exports_external.array(
    exports_external.object({
      index: exports_external.number().int().nonnegative(),
      verdict: verdictSchema,
      binary: exports_external.string().optional(),
    }),
  ),
  learnings: exports_external.array(exports_external.string()),
  sessions: exports_external.array(sessionSummarySchema),
  checkpointInfo: exports_external
    .object({
      outcome: exports_external.enum(['conflict_found', 'spec_auto_fixed', 'spec_compressed', 'no_action']),
      summary: exports_external.string(),
      progressPercent: exports_external.number().optional(),
    })
    .optional(),
});
var metricsSummarySchema = exports_external.object({
  totalDurationMs: exports_external.number().nonnegative(),
  totalInputTokens: exports_external.number().int().nonnegative(),
  totalOutputTokens: exports_external.number().int().nonnegative(),
});
var historyEntrySchema = exports_external.object({
  id: exports_external.string().min(1),
  spec: exports_external.string(),
  config: resolvedConfigSchema,
  status: runStatusSchema,
  iterations: exports_external.number().int().nonnegative(),
  startedAt: exports_external.string().datetime(),
  completedAt: exports_external.string().datetime(),
  summary: exports_external.array(iterationSummarySchema),
  checkpointRan: exports_external.boolean().optional(),
  metricsSummary: metricsSummarySchema.optional(),
});
var checkpointResultSchema = exports_external.object({
  outcome: exports_external.enum(['conflict_found', 'spec_auto_fixed', 'spec_compressed', 'no_action']),
  summary: exports_external.string(),
  progressPercent: exports_external.number().int().min(0).max(100).optional(),
  completedCriteria: exports_external.array(exports_external.string()).optional(),
  remainingCriteria: exports_external.array(exports_external.string()).optional(),
});
function parseHarness(value) {
  if (value === 'claude' || value === 'gemini') {
    return value;
  }
  throw new Error(`Invalid harness type: "${value}". Must be "claude" or "gemini".`);
}
function parseImplementerConfig(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error('Implementer config cannot be empty.');
  }
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount > 1) {
    throw new Error(`Invalid implementer config "${entry}": too many colons. Expected format: binary:harness`);
  }
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    return { binary: trimmed, harness: 'claude' };
  }
  if (colonIndex === 0) {
    throw new Error(`Invalid implementer config "${entry}": binary name cannot be empty.`);
  }
  const binary = trimmed.slice(0, colonIndex);
  const harnessValue = trimmed.slice(colonIndex + 1);
  if (!harnessValue) {
    throw new Error(`Invalid implementer config "${entry}": harness cannot be empty.`);
  }
  return {
    binary,
    harness: parseHarness(harnessValue),
  };
}
function parseReviewerConfig(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new Error('Reviewer config cannot be empty.');
  }
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount > 2) {
    throw new Error(
      `Invalid reviewer config "${entry}": too many colons. Expected format: binary:harness:flag or binary:flag`,
    );
  }
  const lastColonIndex = trimmed.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return { ...parseImplementerConfig(trimmed), noVerdictAsFailure: true };
  }
  const potentialFlag = trimmed.slice(lastColonIndex + 1);
  if (potentialFlag.length > 0 && /^\d+$/.test(potentialFlag) && potentialFlag !== '0' && potentialFlag !== '1') {
    throw new Error(`Invalid reviewer config "${entry}": reviewer flag must be 0 or 1, got "${potentialFlag}".`);
  }
  if (potentialFlag === '0' || potentialFlag === '1') {
    const binaryPart = trimmed.slice(0, lastColonIndex);
    if (!binaryPart) {
      throw new Error(`Invalid reviewer config "${entry}": binary name cannot be empty.`);
    }
    const parsed = parseImplementerConfig(binaryPart);
    return {
      ...parsed,
      noVerdictAsFailure: potentialFlag === '1',
    };
  }
  return { ...parseImplementerConfig(trimmed), noVerdictAsFailure: true };
}
function parseConflictCheckerConfig(entry) {
  return parseImplementerConfig(entry);
}
function getPrimaryImplementer(config) {
  return Object.keys(config.implementers)[0];
}
function selectImplementer(config) {
  const entries = Object.entries(config.implementers);
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let rand = Math.random() * totalWeight;
  for (const [binary, weight] of entries) {
    rand -= weight;
    if (rand <= 0) return binary;
  }
  return entries[entries.length - 1][0];
}
function parseRawConfig(data) {
  const result = configSchema.safeParse(data);
  if (!result.success) {
    return resolvedConfigSchema.parse(data);
  }
  return resolvedConfigSchema.parse(result.data);
}
function parseRun(data) {
  return runSchema.parse(data);
}
function parseSession(data) {
  return sessionSchema.parse(data);
}
function parseHistoryEntry(data) {
  return historyEntrySchema.parse(data);
}
var EVENT_TYPES = {
  RUN_START: 'run_start',
  CANCEL: 'cancel',
  STOP: 'stop',
  COMPLETED: 'completed',
  ERROR: 'error',
  CONFLICT: 'conflict',
  AGENT_FAILURE: 'agent_failure',
  CRASHED: 'crashed',
  LOOP_START: 'loop_start',
  IMPLEMENTER_START: 'implementer_start',
  IMPLEMENTER_END: 'implementer_end',
  REVIEW_PHASE_START: 'review_phase_start',
  REVIEWER_START: 'reviewer_start',
  REVIEWER_END: 'reviewer_end',
  REVIEW_PHASE_END: 'review_phase_end',
  CHECKPOINT: 'checkpoint',
  CHECKPOINT_START: 'checkpoint_start',
  CHECKPOINT_END: 'checkpoint_end',
  LOOP_END: 'loop_end',
};

// src/loop/consensus.ts
function checkConsensus(verdicts, totalPhases = 1, completedPhases = 1) {
  const approved = verdicts.filter(v => v.verdict === 'approved');
  const rejected = verdicts.filter(v => v.verdict === 'rejected');
  const incomplete = verdicts.filter(v => v.verdict !== 'approved' && v.verdict !== 'rejected');
  return {
    approved: approved.length === verdicts.length && incomplete.length === 0,
    rejected: rejected.length > 0,
    incomplete: incomplete.length > 0,
    partial: completedPhases < totalPhases && rejected.length > 0,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    totalReviewers: verdicts.length,
    totalPhases,
    completedPhases,
  };
}

// src/agents/prompts.ts
function substitute(template, vars) {
  return template.replace(/{(\w+)}/g, (_, key) => vars[key] ?? `{${key}}`);
}
function buildImplementerPrompt(template, vars) {
  return substitute(template ?? DEFAULT_IMPLEMENTER_PROMPT, vars);
}
function buildReviewerPrompt(template, vars) {
  let prompt = template ?? DEFAULT_REVIEWER_PROMPT;
  const archivedSection =
    vars.archivedReviews !== null
      ? `Check the previous loop's completed reviews at ${vars.archivedReviews}/ for context on what reviewers found.
(Read these for background only \u2014 do not let previous reviewers opinions override your own assessment of the spec and code.)`
      : `No previous loop reviews available yet.`;
  prompt = substitute(prompt, { ...vars, archivedReviews: archivedSection });
  return prompt;
}
function buildCheckpointerPrompt(conflictOnlyTemplate, fullTemplate, vars, compressSpec) {
  const template = compressSpec ? fullTemplate : conflictOnlyTemplate;
  if (template) return substitute(template, vars);
  const defaultTemplate = compressSpec ? DEFAULT_CHECKPOINTER_PROMPT : CONFLICT_ONLY_CHECKPOINTER_PROMPT;
  return substitute(defaultTemplate, vars);
}

// src/loop/iteration.ts
function buildIterationData(run, config, specPath, _specContent, runId, loopNum, paths2) {
  const reviewsDir = paths2.loopReviewsPath(runId, loopNum);
  const verdictsDir = paths2.loopVerdictsPath(runId, loopNum);
  const evidenceDir = paths2.loopEvidencePath(runId, loopNum);
  const learningsFile = paths2.runLearnings(runId);
  const implReviewsDir =
    loopNum > 1 ? paths2.loopReviewsPath(runId, loopNum - 1) : paths2.loopReviewsPath(runId, loopNum);
  const implVars = {
    specPath,
    iteration: String(run.iteration),
    reviewsDir: implReviewsDir,
    evidenceDir,
    learningsFile,
  };
  const implementerPrompt = buildImplementerPrompt(config.prompts?.implementer, implVars);
  const allReviewers = config.reviewPhases.flat();
  const prevLoop = loopNum > 1 ? loopNum - 1 : null;
  const reviewerPrompts = Array.from({ length: allReviewers.length }, (_, i) => {
    const seesPrevReviews = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
    const archivedReviews = seesPrevReviews ? paths2.loopReviewsPath(runId, prevLoop) : null;
    const revVars = {
      specPath,
      iteration: String(run.iteration),
      reviewerIndex: String(i),
      reviewsDir,
      verdictsDir,
      evidenceDir,
      learningsFile,
      archivedReviews,
    };
    return {
      reviewerIndex: i,
      prompt: buildReviewerPrompt(config.prompts?.reviewer, revVars),
    };
  });
  return {
    run,
    config,
    spec: _specContent,
    learnings: run.learnings,
    implementerPrompt,
    reviewerPrompts,
  };
}

// src/agents/runner.ts
import * as fs4 from 'fs/promises';
import * as path4 from 'path';

// src/agents/verdicts.ts
function parseVerdictFile(content) {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.approved === 'boolean') {
      return {
        verdict: parsed.approved ? 'approved' : 'rejected',
        reasoning: parsed.reasoning ?? '',
        completionEstimate: parsed.completionEstimate,
      };
    }
    return { verdict: null, reasoning: '' };
  } catch {
    return { verdict: null, reasoning: '' };
  }
}
function parseVerdictFromText(text) {
  const upper = text.toUpperCase().trim();
  if (upper.includes('APPROVED')) {
    return 'approved';
  }
  if (upper.includes('REJECTED')) {
    return 'rejected';
  }
  return null;
}

// src/stream/parse.ts
function tryParseJson(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return normalizeEvent(parsed);
  } catch {
    return null;
  }
}
function normalizeEvent(obj) {
  if (!obj || typeof obj !== 'object') {
    return { type: 'unknown', raw: obj };
  }
  const o = obj;
  if (o.type === 'result' && o.status === 'error' && o.error) {
    const error = o.error;
    return { type: 'error', error: { message: error.message ?? 'Unknown error' } };
  }
  if (o.type === 'system' && typeof o.message === 'string') {
    return { type: 'system', message: o.message, timestamp: o.timestamp };
  }
  if (o.type === 'assistant' && o.message) {
    return { type: 'assistant', message: o.message };
  }
  if (o.type === 'user' && o.message) {
    return { type: 'user', message: o.message };
  }
  if (o.type === 'result' && o.result) {
    return { type: 'result', result: o.result };
  }
  if (o.type === 'error' && o.error) {
    return { type: 'error', error: o.error };
  }
  if (o.type === 'init' && typeof o.session_id === 'string') {
    return {
      type: 'system',
      subtype: 'init',
      session_id: o.session_id,
      tools: [],
    };
  }
  if (o.type === 'message' && (o.role === 'model' || o.role === 'assistant')) {
    const content = o.content;
    let normalizedContent;
    if (typeof content === 'string') {
      normalizedContent = [{ type: 'text', text: content }];
    } else if (Array.isArray(content)) {
      normalizedContent = content;
    } else {
      normalizedContent = [];
    }
    return {
      type: 'assistant',
      message: {
        content: normalizedContent,
      },
    };
  }
  if (o.type === 'message' && o.role === 'user') {
    const content = o.content;
    return {
      type: 'user',
      message: {
        content: typeof content === 'string' ? content : Array.isArray(content) ? content : '',
      },
    };
  }
  if (o.type === 'result' && o.status === 'success' && o.stats) {
    const stats = o.stats;
    return {
      type: 'result',
      result: {
        duration_ms: stats.duration_ms,
        input_tokens: stats.input_tokens,
        output_tokens: stats.output_tokens,
      },
    };
  }
  return { type: 'unknown', raw: obj };
}
function extractText(content) {
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
}
function extractToolUses(content) {
  return content.filter(c => c.type === 'tool_use').map(c => ({ name: c.name, input: c.input }));
}
async function extractHarnessSessionId(logFilePath) {
  try {
    const { readFile: readFile4 } = await import('fs/promises');
    const content = await readFile4(logFilePath, 'utf-8');
    return extractHarnessSessionIdFromContent(content);
  } catch {
    return;
  }
}
function extractHarnessSessionIdFromContent(content) {
  for (const line of content.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'init' && typeof parsed.session_id === 'string') {
        return parsed.session_id;
      }
    } catch {}
  }
  return;
}
async function extractTokensFromLog(logFilePath) {
  try {
    const { readFile: readFile4 } = await import('fs/promises');
    const content = await readFile4(logFilePath, 'utf-8');
    return extractTokensFromContent(content);
  } catch {
    return {};
  }
}
function extractTokensFromContent(content) {
  const result = {};
  for (const line of content.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'result') {
        const usage = parsed.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          result.inputTokens = usage.input_tokens;
        }
        if (usage && typeof usage.output_tokens === 'number') {
          result.outputTokens = usage.output_tokens;
        }
        const stats = parsed.stats;
        if (stats) {
          if (typeof stats.input_tokens === 'number' && result.inputTokens === undefined) {
            result.inputTokens = stats.input_tokens;
          }
          if (typeof stats.output_tokens === 'number' && result.outputTokens === undefined) {
            result.outputTokens = stats.output_tokens;
          }
          if (
            typeof stats.total_tokens === 'number' &&
            result.inputTokens === undefined &&
            result.outputTokens === undefined
          ) {
          }
        }
        break;
      }
    } catch {}
  }
  return result;
}

// src/loop/format.ts
var import_picocolors3 = __toESM(require_picocolors(), 1);

// node_modules/date-fns/constants.js
var daysInYear = 365.2425;
var maxTime = Math.pow(10, 8) * 24 * 60 * 60 * 1000;
var minTime = -maxTime;
var millisecondsInWeek = 604800000;
var millisecondsInDay = 86400000;
var secondsInHour = 3600;
var secondsInDay = secondsInHour * 24;
var secondsInWeek = secondsInDay * 7;
var secondsInYear = secondsInDay * daysInYear;
var secondsInMonth = secondsInYear / 12;
var secondsInQuarter = secondsInMonth * 3;
var constructFromSymbol = Symbol.for('constructDateFrom');

// node_modules/date-fns/constructFrom.js
function constructFrom(date, value) {
  if (typeof date === 'function') return date(value);
  if (date && typeof date === 'object' && constructFromSymbol in date) return date[constructFromSymbol](value);
  if (date instanceof Date) return new date.constructor(value);
  return new Date(value);
}

// node_modules/date-fns/toDate.js
function toDate(argument, context) {
  return constructFrom(context || argument, argument);
}

// node_modules/date-fns/_lib/defaultOptions.js
var defaultOptions = {};
function getDefaultOptions() {
  return defaultOptions;
}

// node_modules/date-fns/startOfWeek.js
function startOfWeek(date, options) {
  const defaultOptions2 = getDefaultOptions();
  const weekStartsOn =
    options?.weekStartsOn ??
    options?.locale?.options?.weekStartsOn ??
    defaultOptions2.weekStartsOn ??
    defaultOptions2.locale?.options?.weekStartsOn ??
    0;
  const _date = toDate(date, options?.in);
  const day = _date.getDay();
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
  _date.setDate(_date.getDate() - diff);
  _date.setHours(0, 0, 0, 0);
  return _date;
}

// node_modules/date-fns/startOfISOWeek.js
function startOfISOWeek(date, options) {
  return startOfWeek(date, { ...options, weekStartsOn: 1 });
}

// node_modules/date-fns/getISOWeekYear.js
function getISOWeekYear(date, options) {
  const _date = toDate(date, options?.in);
  const year = _date.getFullYear();
  const fourthOfJanuaryOfNextYear = constructFrom(_date, 0);
  fourthOfJanuaryOfNextYear.setFullYear(year + 1, 0, 4);
  fourthOfJanuaryOfNextYear.setHours(0, 0, 0, 0);
  const startOfNextYear = startOfISOWeek(fourthOfJanuaryOfNextYear);
  const fourthOfJanuaryOfThisYear = constructFrom(_date, 0);
  fourthOfJanuaryOfThisYear.setFullYear(year, 0, 4);
  fourthOfJanuaryOfThisYear.setHours(0, 0, 0, 0);
  const startOfThisYear = startOfISOWeek(fourthOfJanuaryOfThisYear);
  if (_date.getTime() >= startOfNextYear.getTime()) {
    return year + 1;
  } else if (_date.getTime() >= startOfThisYear.getTime()) {
    return year;
  } else {
    return year - 1;
  }
}

// node_modules/date-fns/_lib/getTimezoneOffsetInMilliseconds.js
function getTimezoneOffsetInMilliseconds(date) {
  const _date = toDate(date);
  const utcDate = new Date(
    Date.UTC(
      _date.getFullYear(),
      _date.getMonth(),
      _date.getDate(),
      _date.getHours(),
      _date.getMinutes(),
      _date.getSeconds(),
      _date.getMilliseconds(),
    ),
  );
  utcDate.setUTCFullYear(_date.getFullYear());
  return +date - +utcDate;
}

// node_modules/date-fns/_lib/normalizeDates.js
function normalizeDates(context, ...dates) {
  const normalize = constructFrom.bind(null, context || dates.find(date => typeof date === 'object'));
  return dates.map(normalize);
}

// node_modules/date-fns/startOfDay.js
function startOfDay(date, options) {
  const _date = toDate(date, options?.in);
  _date.setHours(0, 0, 0, 0);
  return _date;
}

// node_modules/date-fns/differenceInCalendarDays.js
function differenceInCalendarDays(laterDate, earlierDate, options) {
  const [laterDate_, earlierDate_] = normalizeDates(options?.in, laterDate, earlierDate);
  const laterStartOfDay = startOfDay(laterDate_);
  const earlierStartOfDay = startOfDay(earlierDate_);
  const laterTimestamp = +laterStartOfDay - getTimezoneOffsetInMilliseconds(laterStartOfDay);
  const earlierTimestamp = +earlierStartOfDay - getTimezoneOffsetInMilliseconds(earlierStartOfDay);
  return Math.round((laterTimestamp - earlierTimestamp) / millisecondsInDay);
}

// node_modules/date-fns/startOfISOWeekYear.js
function startOfISOWeekYear(date, options) {
  const year = getISOWeekYear(date, options);
  const fourthOfJanuary = constructFrom(options?.in || date, 0);
  fourthOfJanuary.setFullYear(year, 0, 4);
  fourthOfJanuary.setHours(0, 0, 0, 0);
  return startOfISOWeek(fourthOfJanuary);
}

// node_modules/date-fns/isDate.js
function isDate(value) {
  return (
    value instanceof Date || (typeof value === 'object' && Object.prototype.toString.call(value) === '[object Date]')
  );
}

// node_modules/date-fns/isValid.js
function isValid2(date) {
  return !((!isDate(date) && typeof date !== 'number') || isNaN(+toDate(date)));
}

// node_modules/date-fns/startOfYear.js
function startOfYear(date, options) {
  const date_ = toDate(date, options?.in);
  date_.setFullYear(date_.getFullYear(), 0, 1);
  date_.setHours(0, 0, 0, 0);
  return date_;
}

// node_modules/date-fns/locale/en-US/_lib/formatDistance.js
var formatDistanceLocale = {
  lessThanXSeconds: {
    one: 'less than a second',
    other: 'less than {{count}} seconds',
  },
  xSeconds: {
    one: '1 second',
    other: '{{count}} seconds',
  },
  halfAMinute: 'half a minute',
  lessThanXMinutes: {
    one: 'less than a minute',
    other: 'less than {{count}} minutes',
  },
  xMinutes: {
    one: '1 minute',
    other: '{{count}} minutes',
  },
  aboutXHours: {
    one: 'about 1 hour',
    other: 'about {{count}} hours',
  },
  xHours: {
    one: '1 hour',
    other: '{{count}} hours',
  },
  xDays: {
    one: '1 day',
    other: '{{count}} days',
  },
  aboutXWeeks: {
    one: 'about 1 week',
    other: 'about {{count}} weeks',
  },
  xWeeks: {
    one: '1 week',
    other: '{{count}} weeks',
  },
  aboutXMonths: {
    one: 'about 1 month',
    other: 'about {{count}} months',
  },
  xMonths: {
    one: '1 month',
    other: '{{count}} months',
  },
  aboutXYears: {
    one: 'about 1 year',
    other: 'about {{count}} years',
  },
  xYears: {
    one: '1 year',
    other: '{{count}} years',
  },
  overXYears: {
    one: 'over 1 year',
    other: 'over {{count}} years',
  },
  almostXYears: {
    one: 'almost 1 year',
    other: 'almost {{count}} years',
  },
};
var formatDistance = (token, count, options) => {
  let result;
  const tokenValue = formatDistanceLocale[token];
  if (typeof tokenValue === 'string') {
    result = tokenValue;
  } else if (count === 1) {
    result = tokenValue.one;
  } else {
    result = tokenValue.other.replace('{{count}}', count.toString());
  }
  if (options?.addSuffix) {
    if (options.comparison && options.comparison > 0) {
      return 'in ' + result;
    } else {
      return result + ' ago';
    }
  }
  return result;
};

// node_modules/date-fns/locale/_lib/buildFormatLongFn.js
function buildFormatLongFn(args) {
  return (options = {}) => {
    const width = options.width ? String(options.width) : args.defaultWidth;
    const format = args.formats[width] || args.formats[args.defaultWidth];
    return format;
  };
}

// node_modules/date-fns/locale/en-US/_lib/formatLong.js
var dateFormats = {
  full: 'EEEE, MMMM do, y',
  long: 'MMMM do, y',
  medium: 'MMM d, y',
  short: 'MM/dd/yyyy',
};
var timeFormats = {
  full: 'h:mm:ss a zzzz',
  long: 'h:mm:ss a z',
  medium: 'h:mm:ss a',
  short: 'h:mm a',
};
var dateTimeFormats = {
  full: "{{date}} 'at' {{time}}",
  long: "{{date}} 'at' {{time}}",
  medium: '{{date}}, {{time}}',
  short: '{{date}}, {{time}}',
};
var formatLong = {
  date: buildFormatLongFn({
    formats: dateFormats,
    defaultWidth: 'full',
  }),
  time: buildFormatLongFn({
    formats: timeFormats,
    defaultWidth: 'full',
  }),
  dateTime: buildFormatLongFn({
    formats: dateTimeFormats,
    defaultWidth: 'full',
  }),
};

// node_modules/date-fns/locale/en-US/_lib/formatRelative.js
var formatRelativeLocale = {
  lastWeek: "'last' eeee 'at' p",
  yesterday: "'yesterday at' p",
  today: "'today at' p",
  tomorrow: "'tomorrow at' p",
  nextWeek: "eeee 'at' p",
  other: 'P',
};
var formatRelative = (token, _date, _baseDate, _options) => formatRelativeLocale[token];

// node_modules/date-fns/locale/_lib/buildLocalizeFn.js
function buildLocalizeFn(args) {
  return (value, options) => {
    const context = options?.context ? String(options.context) : 'standalone';
    let valuesArray;
    if (context === 'formatting' && args.formattingValues) {
      const defaultWidth = args.defaultFormattingWidth || args.defaultWidth;
      const width = options?.width ? String(options.width) : defaultWidth;
      valuesArray = args.formattingValues[width] || args.formattingValues[defaultWidth];
    } else {
      const defaultWidth = args.defaultWidth;
      const width = options?.width ? String(options.width) : args.defaultWidth;
      valuesArray = args.values[width] || args.values[defaultWidth];
    }
    const index = args.argumentCallback ? args.argumentCallback(value) : value;
    return valuesArray[index];
  };
}

// node_modules/date-fns/locale/en-US/_lib/localize.js
var eraValues = {
  narrow: ['B', 'A'],
  abbreviated: ['BC', 'AD'],
  wide: ['Before Christ', 'Anno Domini'],
};
var quarterValues = {
  narrow: ['1', '2', '3', '4'],
  abbreviated: ['Q1', 'Q2', 'Q3', 'Q4'],
  wide: ['1st quarter', '2nd quarter', '3rd quarter', '4th quarter'],
};
var monthValues = {
  narrow: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
  abbreviated: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  wide: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
};
var dayValues = {
  narrow: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  short: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
  abbreviated: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  wide: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
var dayPeriodValues = {
  narrow: {
    am: 'a',
    pm: 'p',
    midnight: 'mi',
    noon: 'n',
    morning: 'morning',
    afternoon: 'afternoon',
    evening: 'evening',
    night: 'night',
  },
  abbreviated: {
    am: 'AM',
    pm: 'PM',
    midnight: 'midnight',
    noon: 'noon',
    morning: 'morning',
    afternoon: 'afternoon',
    evening: 'evening',
    night: 'night',
  },
  wide: {
    am: 'a.m.',
    pm: 'p.m.',
    midnight: 'midnight',
    noon: 'noon',
    morning: 'morning',
    afternoon: 'afternoon',
    evening: 'evening',
    night: 'night',
  },
};
var formattingDayPeriodValues = {
  narrow: {
    am: 'a',
    pm: 'p',
    midnight: 'mi',
    noon: 'n',
    morning: 'in the morning',
    afternoon: 'in the afternoon',
    evening: 'in the evening',
    night: 'at night',
  },
  abbreviated: {
    am: 'AM',
    pm: 'PM',
    midnight: 'midnight',
    noon: 'noon',
    morning: 'in the morning',
    afternoon: 'in the afternoon',
    evening: 'in the evening',
    night: 'at night',
  },
  wide: {
    am: 'a.m.',
    pm: 'p.m.',
    midnight: 'midnight',
    noon: 'noon',
    morning: 'in the morning',
    afternoon: 'in the afternoon',
    evening: 'in the evening',
    night: 'at night',
  },
};
var ordinalNumber = (dirtyNumber, _options) => {
  const number = Number(dirtyNumber);
  const rem100 = number % 100;
  if (rem100 > 20 || rem100 < 10) {
    switch (rem100 % 10) {
      case 1:
        return number + 'st';
      case 2:
        return number + 'nd';
      case 3:
        return number + 'rd';
    }
  }
  return number + 'th';
};
var localize = {
  ordinalNumber,
  era: buildLocalizeFn({
    values: eraValues,
    defaultWidth: 'wide',
  }),
  quarter: buildLocalizeFn({
    values: quarterValues,
    defaultWidth: 'wide',
    argumentCallback: quarter => quarter - 1,
  }),
  month: buildLocalizeFn({
    values: monthValues,
    defaultWidth: 'wide',
  }),
  day: buildLocalizeFn({
    values: dayValues,
    defaultWidth: 'wide',
  }),
  dayPeriod: buildLocalizeFn({
    values: dayPeriodValues,
    defaultWidth: 'wide',
    formattingValues: formattingDayPeriodValues,
    defaultFormattingWidth: 'wide',
  }),
};

// node_modules/date-fns/locale/_lib/buildMatchFn.js
function buildMatchFn(args) {
  return (string, options = {}) => {
    const width = options.width;
    const matchPattern = (width && args.matchPatterns[width]) || args.matchPatterns[args.defaultMatchWidth];
    const matchResult = string.match(matchPattern);
    if (!matchResult) {
      return null;
    }
    const matchedString = matchResult[0];
    const parsePatterns = (width && args.parsePatterns[width]) || args.parsePatterns[args.defaultParseWidth];
    const key = Array.isArray(parsePatterns)
      ? findIndex(parsePatterns, pattern => pattern.test(matchedString))
      : findKey(parsePatterns, pattern => pattern.test(matchedString));
    let value;
    value = args.valueCallback ? args.valueCallback(key) : key;
    value = options.valueCallback ? options.valueCallback(value) : value;
    const rest = string.slice(matchedString.length);
    return { value, rest };
  };
}
function findKey(object, predicate) {
  for (const key in object) {
    if (Object.prototype.hasOwnProperty.call(object, key) && predicate(object[key])) {
      return key;
    }
  }
  return;
}
function findIndex(array, predicate) {
  for (let key = 0; key < array.length; key++) {
    if (predicate(array[key])) {
      return key;
    }
  }
  return;
}

// node_modules/date-fns/locale/_lib/buildMatchPatternFn.js
function buildMatchPatternFn(args) {
  return (string, options = {}) => {
    const matchResult = string.match(args.matchPattern);
    if (!matchResult) return null;
    const matchedString = matchResult[0];
    const parseResult = string.match(args.parsePattern);
    if (!parseResult) return null;
    let value = args.valueCallback ? args.valueCallback(parseResult[0]) : parseResult[0];
    value = options.valueCallback ? options.valueCallback(value) : value;
    const rest = string.slice(matchedString.length);
    return { value, rest };
  };
}

// node_modules/date-fns/locale/en-US/_lib/match.js
var matchOrdinalNumberPattern = /^(\d+)(th|st|nd|rd)?/i;
var parseOrdinalNumberPattern = /\d+/i;
var matchEraPatterns = {
  narrow: /^(b|a)/i,
  abbreviated: /^(b\.?\s?c\.?|b\.?\s?c\.?\s?e\.?|a\.?\s?d\.?|c\.?\s?e\.?)/i,
  wide: /^(before christ|before common era|anno domini|common era)/i,
};
var parseEraPatterns = {
  any: [/^b/i, /^(a|c)/i],
};
var matchQuarterPatterns = {
  narrow: /^[1234]/i,
  abbreviated: /^q[1234]/i,
  wide: /^[1234](th|st|nd|rd)? quarter/i,
};
var parseQuarterPatterns = {
  any: [/1/i, /2/i, /3/i, /4/i],
};
var matchMonthPatterns = {
  narrow: /^[jfmasond]/i,
  abbreviated: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  wide: /^(january|february|march|april|may|june|july|august|september|october|november|december)/i,
};
var parseMonthPatterns = {
  narrow: [/^j/i, /^f/i, /^m/i, /^a/i, /^m/i, /^j/i, /^j/i, /^a/i, /^s/i, /^o/i, /^n/i, /^d/i],
  any: [/^ja/i, /^f/i, /^mar/i, /^ap/i, /^may/i, /^jun/i, /^jul/i, /^au/i, /^s/i, /^o/i, /^n/i, /^d/i],
};
var matchDayPatterns = {
  narrow: /^[smtwf]/i,
  short: /^(su|mo|tu|we|th|fr|sa)/i,
  abbreviated: /^(sun|mon|tue|wed|thu|fri|sat)/i,
  wide: /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i,
};
var parseDayPatterns = {
  narrow: [/^s/i, /^m/i, /^t/i, /^w/i, /^t/i, /^f/i, /^s/i],
  any: [/^su/i, /^m/i, /^tu/i, /^w/i, /^th/i, /^f/i, /^sa/i],
};
var matchDayPeriodPatterns = {
  narrow: /^(a|p|mi|n|(in the|at) (morning|afternoon|evening|night))/i,
  any: /^([ap]\.?\s?m\.?|midnight|noon|(in the|at) (morning|afternoon|evening|night))/i,
};
var parseDayPeriodPatterns = {
  any: {
    am: /^a/i,
    pm: /^p/i,
    midnight: /^mi/i,
    noon: /^no/i,
    morning: /morning/i,
    afternoon: /afternoon/i,
    evening: /evening/i,
    night: /night/i,
  },
};
var match = {
  ordinalNumber: buildMatchPatternFn({
    matchPattern: matchOrdinalNumberPattern,
    parsePattern: parseOrdinalNumberPattern,
    valueCallback: value => parseInt(value, 10),
  }),
  era: buildMatchFn({
    matchPatterns: matchEraPatterns,
    defaultMatchWidth: 'wide',
    parsePatterns: parseEraPatterns,
    defaultParseWidth: 'any',
  }),
  quarter: buildMatchFn({
    matchPatterns: matchQuarterPatterns,
    defaultMatchWidth: 'wide',
    parsePatterns: parseQuarterPatterns,
    defaultParseWidth: 'any',
    valueCallback: index => index + 1,
  }),
  month: buildMatchFn({
    matchPatterns: matchMonthPatterns,
    defaultMatchWidth: 'wide',
    parsePatterns: parseMonthPatterns,
    defaultParseWidth: 'any',
  }),
  day: buildMatchFn({
    matchPatterns: matchDayPatterns,
    defaultMatchWidth: 'wide',
    parsePatterns: parseDayPatterns,
    defaultParseWidth: 'any',
  }),
  dayPeriod: buildMatchFn({
    matchPatterns: matchDayPeriodPatterns,
    defaultMatchWidth: 'any',
    parsePatterns: parseDayPeriodPatterns,
    defaultParseWidth: 'any',
  }),
};

// node_modules/date-fns/locale/en-US.js
var enUS = {
  code: 'en-US',
  formatDistance,
  formatLong,
  formatRelative,
  localize,
  match,
  options: {
    weekStartsOn: 0,
    firstWeekContainsDate: 1,
  },
};
// node_modules/date-fns/getDayOfYear.js
function getDayOfYear(date, options) {
  const _date = toDate(date, options?.in);
  const diff = differenceInCalendarDays(_date, startOfYear(_date));
  const dayOfYear = diff + 1;
  return dayOfYear;
}

// node_modules/date-fns/getISOWeek.js
function getISOWeek(date, options) {
  const _date = toDate(date, options?.in);
  const diff = +startOfISOWeek(_date) - +startOfISOWeekYear(_date);
  return Math.round(diff / millisecondsInWeek) + 1;
}

// node_modules/date-fns/getWeekYear.js
function getWeekYear(date, options) {
  const _date = toDate(date, options?.in);
  const year = _date.getFullYear();
  const defaultOptions2 = getDefaultOptions();
  const firstWeekContainsDate =
    options?.firstWeekContainsDate ??
    options?.locale?.options?.firstWeekContainsDate ??
    defaultOptions2.firstWeekContainsDate ??
    defaultOptions2.locale?.options?.firstWeekContainsDate ??
    1;
  const firstWeekOfNextYear = constructFrom(options?.in || date, 0);
  firstWeekOfNextYear.setFullYear(year + 1, 0, firstWeekContainsDate);
  firstWeekOfNextYear.setHours(0, 0, 0, 0);
  const startOfNextYear = startOfWeek(firstWeekOfNextYear, options);
  const firstWeekOfThisYear = constructFrom(options?.in || date, 0);
  firstWeekOfThisYear.setFullYear(year, 0, firstWeekContainsDate);
  firstWeekOfThisYear.setHours(0, 0, 0, 0);
  const startOfThisYear = startOfWeek(firstWeekOfThisYear, options);
  if (+_date >= +startOfNextYear) {
    return year + 1;
  } else if (+_date >= +startOfThisYear) {
    return year;
  } else {
    return year - 1;
  }
}

// node_modules/date-fns/startOfWeekYear.js
function startOfWeekYear(date, options) {
  const defaultOptions2 = getDefaultOptions();
  const firstWeekContainsDate =
    options?.firstWeekContainsDate ??
    options?.locale?.options?.firstWeekContainsDate ??
    defaultOptions2.firstWeekContainsDate ??
    defaultOptions2.locale?.options?.firstWeekContainsDate ??
    1;
  const year = getWeekYear(date, options);
  const firstWeek = constructFrom(options?.in || date, 0);
  firstWeek.setFullYear(year, 0, firstWeekContainsDate);
  firstWeek.setHours(0, 0, 0, 0);
  const _date = startOfWeek(firstWeek, options);
  return _date;
}

// node_modules/date-fns/getWeek.js
function getWeek(date, options) {
  const _date = toDate(date, options?.in);
  const diff = +startOfWeek(_date, options) - +startOfWeekYear(_date, options);
  return Math.round(diff / millisecondsInWeek) + 1;
}

// node_modules/date-fns/_lib/addLeadingZeros.js
function addLeadingZeros(number, targetLength) {
  const sign = number < 0 ? '-' : '';
  const output = Math.abs(number).toString().padStart(targetLength, '0');
  return sign + output;
}

// node_modules/date-fns/_lib/format/lightFormatters.js
var lightFormatters = {
  y(date, token) {
    const signedYear = date.getFullYear();
    const year = signedYear > 0 ? signedYear : 1 - signedYear;
    return addLeadingZeros(token === 'yy' ? year % 100 : year, token.length);
  },
  M(date, token) {
    const month = date.getMonth();
    return token === 'M' ? String(month + 1) : addLeadingZeros(month + 1, 2);
  },
  d(date, token) {
    return addLeadingZeros(date.getDate(), token.length);
  },
  a(date, token) {
    const dayPeriodEnumValue = date.getHours() / 12 >= 1 ? 'pm' : 'am';
    switch (token) {
      case 'a':
      case 'aa':
        return dayPeriodEnumValue.toUpperCase();
      case 'aaa':
        return dayPeriodEnumValue;
      case 'aaaaa':
        return dayPeriodEnumValue[0];
      case 'aaaa':
      default:
        return dayPeriodEnumValue === 'am' ? 'a.m.' : 'p.m.';
    }
  },
  h(date, token) {
    return addLeadingZeros(date.getHours() % 12 || 12, token.length);
  },
  H(date, token) {
    return addLeadingZeros(date.getHours(), token.length);
  },
  m(date, token) {
    return addLeadingZeros(date.getMinutes(), token.length);
  },
  s(date, token) {
    return addLeadingZeros(date.getSeconds(), token.length);
  },
  S(date, token) {
    const numberOfDigits = token.length;
    const milliseconds = date.getMilliseconds();
    const fractionalSeconds = Math.trunc(milliseconds * Math.pow(10, numberOfDigits - 3));
    return addLeadingZeros(fractionalSeconds, token.length);
  },
};

// node_modules/date-fns/_lib/format/formatters.js
var dayPeriodEnum = {
  am: 'am',
  pm: 'pm',
  midnight: 'midnight',
  noon: 'noon',
  morning: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
  night: 'night',
};
var formatters = {
  G: function (date, token, localize2) {
    const era = date.getFullYear() > 0 ? 1 : 0;
    switch (token) {
      case 'G':
      case 'GG':
      case 'GGG':
        return localize2.era(era, { width: 'abbreviated' });
      case 'GGGGG':
        return localize2.era(era, { width: 'narrow' });
      case 'GGGG':
      default:
        return localize2.era(era, { width: 'wide' });
    }
  },
  y: function (date, token, localize2) {
    if (token === 'yo') {
      const signedYear = date.getFullYear();
      const year = signedYear > 0 ? signedYear : 1 - signedYear;
      return localize2.ordinalNumber(year, { unit: 'year' });
    }
    return lightFormatters.y(date, token);
  },
  Y: function (date, token, localize2, options) {
    const signedWeekYear = getWeekYear(date, options);
    const weekYear = signedWeekYear > 0 ? signedWeekYear : 1 - signedWeekYear;
    if (token === 'YY') {
      const twoDigitYear = weekYear % 100;
      return addLeadingZeros(twoDigitYear, 2);
    }
    if (token === 'Yo') {
      return localize2.ordinalNumber(weekYear, { unit: 'year' });
    }
    return addLeadingZeros(weekYear, token.length);
  },
  R: function (date, token) {
    const isoWeekYear = getISOWeekYear(date);
    return addLeadingZeros(isoWeekYear, token.length);
  },
  u: function (date, token) {
    const year = date.getFullYear();
    return addLeadingZeros(year, token.length);
  },
  Q: function (date, token, localize2) {
    const quarter = Math.ceil((date.getMonth() + 1) / 3);
    switch (token) {
      case 'Q':
        return String(quarter);
      case 'QQ':
        return addLeadingZeros(quarter, 2);
      case 'Qo':
        return localize2.ordinalNumber(quarter, { unit: 'quarter' });
      case 'QQQ':
        return localize2.quarter(quarter, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'QQQQQ':
        return localize2.quarter(quarter, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'QQQQ':
      default:
        return localize2.quarter(quarter, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  q: function (date, token, localize2) {
    const quarter = Math.ceil((date.getMonth() + 1) / 3);
    switch (token) {
      case 'q':
        return String(quarter);
      case 'qq':
        return addLeadingZeros(quarter, 2);
      case 'qo':
        return localize2.ordinalNumber(quarter, { unit: 'quarter' });
      case 'qqq':
        return localize2.quarter(quarter, {
          width: 'abbreviated',
          context: 'standalone',
        });
      case 'qqqqq':
        return localize2.quarter(quarter, {
          width: 'narrow',
          context: 'standalone',
        });
      case 'qqqq':
      default:
        return localize2.quarter(quarter, {
          width: 'wide',
          context: 'standalone',
        });
    }
  },
  M: function (date, token, localize2) {
    const month = date.getMonth();
    switch (token) {
      case 'M':
      case 'MM':
        return lightFormatters.M(date, token);
      case 'Mo':
        return localize2.ordinalNumber(month + 1, { unit: 'month' });
      case 'MMM':
        return localize2.month(month, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'MMMMM':
        return localize2.month(month, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'MMMM':
      default:
        return localize2.month(month, { width: 'wide', context: 'formatting' });
    }
  },
  L: function (date, token, localize2) {
    const month = date.getMonth();
    switch (token) {
      case 'L':
        return String(month + 1);
      case 'LL':
        return addLeadingZeros(month + 1, 2);
      case 'Lo':
        return localize2.ordinalNumber(month + 1, { unit: 'month' });
      case 'LLL':
        return localize2.month(month, {
          width: 'abbreviated',
          context: 'standalone',
        });
      case 'LLLLL':
        return localize2.month(month, {
          width: 'narrow',
          context: 'standalone',
        });
      case 'LLLL':
      default:
        return localize2.month(month, { width: 'wide', context: 'standalone' });
    }
  },
  w: function (date, token, localize2, options) {
    const week = getWeek(date, options);
    if (token === 'wo') {
      return localize2.ordinalNumber(week, { unit: 'week' });
    }
    return addLeadingZeros(week, token.length);
  },
  I: function (date, token, localize2) {
    const isoWeek = getISOWeek(date);
    if (token === 'Io') {
      return localize2.ordinalNumber(isoWeek, { unit: 'week' });
    }
    return addLeadingZeros(isoWeek, token.length);
  },
  d: function (date, token, localize2) {
    if (token === 'do') {
      return localize2.ordinalNumber(date.getDate(), { unit: 'date' });
    }
    return lightFormatters.d(date, token);
  },
  D: function (date, token, localize2) {
    const dayOfYear = getDayOfYear(date);
    if (token === 'Do') {
      return localize2.ordinalNumber(dayOfYear, { unit: 'dayOfYear' });
    }
    return addLeadingZeros(dayOfYear, token.length);
  },
  E: function (date, token, localize2) {
    const dayOfWeek = date.getDay();
    switch (token) {
      case 'E':
      case 'EE':
      case 'EEE':
        return localize2.day(dayOfWeek, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'EEEEE':
        return localize2.day(dayOfWeek, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'EEEEEE':
        return localize2.day(dayOfWeek, {
          width: 'short',
          context: 'formatting',
        });
      case 'EEEE':
      default:
        return localize2.day(dayOfWeek, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  e: function (date, token, localize2, options) {
    const dayOfWeek = date.getDay();
    const localDayOfWeek = (dayOfWeek - options.weekStartsOn + 8) % 7 || 7;
    switch (token) {
      case 'e':
        return String(localDayOfWeek);
      case 'ee':
        return addLeadingZeros(localDayOfWeek, 2);
      case 'eo':
        return localize2.ordinalNumber(localDayOfWeek, { unit: 'day' });
      case 'eee':
        return localize2.day(dayOfWeek, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'eeeee':
        return localize2.day(dayOfWeek, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'eeeeee':
        return localize2.day(dayOfWeek, {
          width: 'short',
          context: 'formatting',
        });
      case 'eeee':
      default:
        return localize2.day(dayOfWeek, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  c: function (date, token, localize2, options) {
    const dayOfWeek = date.getDay();
    const localDayOfWeek = (dayOfWeek - options.weekStartsOn + 8) % 7 || 7;
    switch (token) {
      case 'c':
        return String(localDayOfWeek);
      case 'cc':
        return addLeadingZeros(localDayOfWeek, token.length);
      case 'co':
        return localize2.ordinalNumber(localDayOfWeek, { unit: 'day' });
      case 'ccc':
        return localize2.day(dayOfWeek, {
          width: 'abbreviated',
          context: 'standalone',
        });
      case 'ccccc':
        return localize2.day(dayOfWeek, {
          width: 'narrow',
          context: 'standalone',
        });
      case 'cccccc':
        return localize2.day(dayOfWeek, {
          width: 'short',
          context: 'standalone',
        });
      case 'cccc':
      default:
        return localize2.day(dayOfWeek, {
          width: 'wide',
          context: 'standalone',
        });
    }
  },
  i: function (date, token, localize2) {
    const dayOfWeek = date.getDay();
    const isoDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek;
    switch (token) {
      case 'i':
        return String(isoDayOfWeek);
      case 'ii':
        return addLeadingZeros(isoDayOfWeek, token.length);
      case 'io':
        return localize2.ordinalNumber(isoDayOfWeek, { unit: 'day' });
      case 'iii':
        return localize2.day(dayOfWeek, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'iiiii':
        return localize2.day(dayOfWeek, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'iiiiii':
        return localize2.day(dayOfWeek, {
          width: 'short',
          context: 'formatting',
        });
      case 'iiii':
      default:
        return localize2.day(dayOfWeek, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  a: function (date, token, localize2) {
    const hours = date.getHours();
    const dayPeriodEnumValue = hours / 12 >= 1 ? 'pm' : 'am';
    switch (token) {
      case 'a':
      case 'aa':
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'aaa':
        return localize2
          .dayPeriod(dayPeriodEnumValue, {
            width: 'abbreviated',
            context: 'formatting',
          })
          .toLowerCase();
      case 'aaaaa':
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'aaaa':
      default:
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  b: function (date, token, localize2) {
    const hours = date.getHours();
    let dayPeriodEnumValue;
    if (hours === 12) {
      dayPeriodEnumValue = dayPeriodEnum.noon;
    } else if (hours === 0) {
      dayPeriodEnumValue = dayPeriodEnum.midnight;
    } else {
      dayPeriodEnumValue = hours / 12 >= 1 ? 'pm' : 'am';
    }
    switch (token) {
      case 'b':
      case 'bb':
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'bbb':
        return localize2
          .dayPeriod(dayPeriodEnumValue, {
            width: 'abbreviated',
            context: 'formatting',
          })
          .toLowerCase();
      case 'bbbbb':
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'bbbb':
      default:
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  B: function (date, token, localize2) {
    const hours = date.getHours();
    let dayPeriodEnumValue;
    if (hours >= 17) {
      dayPeriodEnumValue = dayPeriodEnum.evening;
    } else if (hours >= 12) {
      dayPeriodEnumValue = dayPeriodEnum.afternoon;
    } else if (hours >= 4) {
      dayPeriodEnumValue = dayPeriodEnum.morning;
    } else {
      dayPeriodEnumValue = dayPeriodEnum.night;
    }
    switch (token) {
      case 'B':
      case 'BB':
      case 'BBB':
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'abbreviated',
          context: 'formatting',
        });
      case 'BBBBB':
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'narrow',
          context: 'formatting',
        });
      case 'BBBB':
      default:
        return localize2.dayPeriod(dayPeriodEnumValue, {
          width: 'wide',
          context: 'formatting',
        });
    }
  },
  h: function (date, token, localize2) {
    if (token === 'ho') {
      let hours = date.getHours() % 12;
      if (hours === 0) hours = 12;
      return localize2.ordinalNumber(hours, { unit: 'hour' });
    }
    return lightFormatters.h(date, token);
  },
  H: function (date, token, localize2) {
    if (token === 'Ho') {
      return localize2.ordinalNumber(date.getHours(), { unit: 'hour' });
    }
    return lightFormatters.H(date, token);
  },
  K: function (date, token, localize2) {
    const hours = date.getHours() % 12;
    if (token === 'Ko') {
      return localize2.ordinalNumber(hours, { unit: 'hour' });
    }
    return addLeadingZeros(hours, token.length);
  },
  k: function (date, token, localize2) {
    let hours = date.getHours();
    if (hours === 0) hours = 24;
    if (token === 'ko') {
      return localize2.ordinalNumber(hours, { unit: 'hour' });
    }
    return addLeadingZeros(hours, token.length);
  },
  m: function (date, token, localize2) {
    if (token === 'mo') {
      return localize2.ordinalNumber(date.getMinutes(), { unit: 'minute' });
    }
    return lightFormatters.m(date, token);
  },
  s: function (date, token, localize2) {
    if (token === 'so') {
      return localize2.ordinalNumber(date.getSeconds(), { unit: 'second' });
    }
    return lightFormatters.s(date, token);
  },
  S: function (date, token) {
    return lightFormatters.S(date, token);
  },
  X: function (date, token, _localize) {
    const timezoneOffset = date.getTimezoneOffset();
    if (timezoneOffset === 0) {
      return 'Z';
    }
    switch (token) {
      case 'X':
        return formatTimezoneWithOptionalMinutes(timezoneOffset);
      case 'XXXX':
      case 'XX':
        return formatTimezone(timezoneOffset);
      case 'XXXXX':
      case 'XXX':
      default:
        return formatTimezone(timezoneOffset, ':');
    }
  },
  x: function (date, token, _localize) {
    const timezoneOffset = date.getTimezoneOffset();
    switch (token) {
      case 'x':
        return formatTimezoneWithOptionalMinutes(timezoneOffset);
      case 'xxxx':
      case 'xx':
        return formatTimezone(timezoneOffset);
      case 'xxxxx':
      case 'xxx':
      default:
        return formatTimezone(timezoneOffset, ':');
    }
  },
  O: function (date, token, _localize) {
    const timezoneOffset = date.getTimezoneOffset();
    switch (token) {
      case 'O':
      case 'OO':
      case 'OOO':
        return 'GMT' + formatTimezoneShort(timezoneOffset, ':');
      case 'OOOO':
      default:
        return 'GMT' + formatTimezone(timezoneOffset, ':');
    }
  },
  z: function (date, token, _localize) {
    const timezoneOffset = date.getTimezoneOffset();
    switch (token) {
      case 'z':
      case 'zz':
      case 'zzz':
        return 'GMT' + formatTimezoneShort(timezoneOffset, ':');
      case 'zzzz':
      default:
        return 'GMT' + formatTimezone(timezoneOffset, ':');
    }
  },
  t: function (date, token, _localize) {
    const timestamp = Math.trunc(+date / 1000);
    return addLeadingZeros(timestamp, token.length);
  },
  T: function (date, token, _localize) {
    return addLeadingZeros(+date, token.length);
  },
};
function formatTimezoneShort(offset, delimiter = '') {
  const sign = offset > 0 ? '-' : '+';
  const absOffset = Math.abs(offset);
  const hours = Math.trunc(absOffset / 60);
  const minutes = absOffset % 60;
  if (minutes === 0) {
    return sign + String(hours);
  }
  return sign + String(hours) + delimiter + addLeadingZeros(minutes, 2);
}
function formatTimezoneWithOptionalMinutes(offset, delimiter) {
  if (offset % 60 === 0) {
    const sign = offset > 0 ? '-' : '+';
    return sign + addLeadingZeros(Math.abs(offset) / 60, 2);
  }
  return formatTimezone(offset, delimiter);
}
function formatTimezone(offset, delimiter = '') {
  const sign = offset > 0 ? '-' : '+';
  const absOffset = Math.abs(offset);
  const hours = addLeadingZeros(Math.trunc(absOffset / 60), 2);
  const minutes = addLeadingZeros(absOffset % 60, 2);
  return sign + hours + delimiter + minutes;
}

// node_modules/date-fns/_lib/format/longFormatters.js
var dateLongFormatter = (pattern, formatLong2) => {
  switch (pattern) {
    case 'P':
      return formatLong2.date({ width: 'short' });
    case 'PP':
      return formatLong2.date({ width: 'medium' });
    case 'PPP':
      return formatLong2.date({ width: 'long' });
    case 'PPPP':
    default:
      return formatLong2.date({ width: 'full' });
  }
};
var timeLongFormatter = (pattern, formatLong2) => {
  switch (pattern) {
    case 'p':
      return formatLong2.time({ width: 'short' });
    case 'pp':
      return formatLong2.time({ width: 'medium' });
    case 'ppp':
      return formatLong2.time({ width: 'long' });
    case 'pppp':
    default:
      return formatLong2.time({ width: 'full' });
  }
};
var dateTimeLongFormatter = (pattern, formatLong2) => {
  const matchResult = pattern.match(/(P+)(p+)?/) || [];
  const datePattern = matchResult[1];
  const timePattern = matchResult[2];
  if (!timePattern) {
    return dateLongFormatter(pattern, formatLong2);
  }
  let dateTimeFormat;
  switch (datePattern) {
    case 'P':
      dateTimeFormat = formatLong2.dateTime({ width: 'short' });
      break;
    case 'PP':
      dateTimeFormat = formatLong2.dateTime({ width: 'medium' });
      break;
    case 'PPP':
      dateTimeFormat = formatLong2.dateTime({ width: 'long' });
      break;
    case 'PPPP':
    default:
      dateTimeFormat = formatLong2.dateTime({ width: 'full' });
      break;
  }
  return dateTimeFormat
    .replace('{{date}}', dateLongFormatter(datePattern, formatLong2))
    .replace('{{time}}', timeLongFormatter(timePattern, formatLong2));
};
var longFormatters = {
  p: timeLongFormatter,
  P: dateTimeLongFormatter,
};

// node_modules/date-fns/_lib/protectedTokens.js
var dayOfYearTokenRE = /^D+$/;
var weekYearTokenRE = /^Y+$/;
var throwTokens = ['D', 'DD', 'YY', 'YYYY'];
function isProtectedDayOfYearToken(token) {
  return dayOfYearTokenRE.test(token);
}
function isProtectedWeekYearToken(token) {
  return weekYearTokenRE.test(token);
}
function warnOrThrowProtectedError(token, format, input) {
  const _message = message(token, format, input);
  console.warn(_message);
  if (throwTokens.includes(token)) throw new RangeError(_message);
}
function message(token, format, input) {
  const subject = token[0] === 'Y' ? 'years' : 'days of the month';
  return `Use \`${token.toLowerCase()}\` instead of \`${token}\` (in \`${format}\`) for formatting ${subject} to the input \`${input}\`; see: https://github.com/date-fns/date-fns/blob/master/docs/unicodeTokens.md`;
}

// node_modules/date-fns/format.js
var formattingTokensRegExp = /[yYQqMLwIdDecihHKkms]o|(\w)\1*|''|'(''|[^'])+('|$)|./g;
var longFormattingTokensRegExp = /P+p+|P+|p+|''|'(''|[^'])+('|$)|./g;
var escapedStringRegExp = /^'([^]*?)'?$/;
var doubleQuoteRegExp = /''/g;
var unescapedLatinCharacterRegExp = /[a-zA-Z]/;
function format(date, formatStr, options) {
  const defaultOptions2 = getDefaultOptions();
  const locale = options?.locale ?? defaultOptions2.locale ?? enUS;
  const firstWeekContainsDate =
    options?.firstWeekContainsDate ??
    options?.locale?.options?.firstWeekContainsDate ??
    defaultOptions2.firstWeekContainsDate ??
    defaultOptions2.locale?.options?.firstWeekContainsDate ??
    1;
  const weekStartsOn =
    options?.weekStartsOn ??
    options?.locale?.options?.weekStartsOn ??
    defaultOptions2.weekStartsOn ??
    defaultOptions2.locale?.options?.weekStartsOn ??
    0;
  const originalDate = toDate(date, options?.in);
  if (!isValid2(originalDate)) {
    throw new RangeError('Invalid time value');
  }
  let parts = formatStr
    .match(longFormattingTokensRegExp)
    .map(substring => {
      const firstCharacter = substring[0];
      if (firstCharacter === 'p' || firstCharacter === 'P') {
        const longFormatter = longFormatters[firstCharacter];
        return longFormatter(substring, locale.formatLong);
      }
      return substring;
    })
    .join('')
    .match(formattingTokensRegExp)
    .map(substring => {
      if (substring === "''") {
        return { isToken: false, value: "'" };
      }
      const firstCharacter = substring[0];
      if (firstCharacter === "'") {
        return { isToken: false, value: cleanEscapedString(substring) };
      }
      if (formatters[firstCharacter]) {
        return { isToken: true, value: substring };
      }
      if (firstCharacter.match(unescapedLatinCharacterRegExp)) {
        throw new RangeError('Format string contains an unescaped latin alphabet character `' + firstCharacter + '`');
      }
      return { isToken: false, value: substring };
    });
  if (locale.localize.preprocessor) {
    parts = locale.localize.preprocessor(originalDate, parts);
  }
  const formatterOptions = {
    firstWeekContainsDate,
    weekStartsOn,
    locale,
  };
  return parts
    .map(part => {
      if (!part.isToken) return part.value;
      const token = part.value;
      if (
        (!options?.useAdditionalWeekYearTokens && isProtectedWeekYearToken(token)) ||
        (!options?.useAdditionalDayOfYearTokens && isProtectedDayOfYearToken(token))
      ) {
        warnOrThrowProtectedError(token, formatStr, String(date));
      }
      const formatter = formatters[token[0]];
      return formatter(originalDate, token, locale.localize, formatterOptions);
    })
    .join('');
}
function cleanEscapedString(input) {
  const matched = input.match(escapedStringRegExp);
  if (!matched) {
    return input;
  }
  return matched[1].replace(doubleQuoteRegExp, "'");
}

// src/loop/format.ts
function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}
function formatDurationHuman(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}
function formatAgeHuman(date) {
  const now = Date.now();
  const then = date.getTime();
  const diffMs = now - then;
  const diffDays = diffMs / 86400000;
  if (diffDays > 2) {
    return format(date, 'MMM dd, HH:mm');
  }
  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${Math.floor(diffMs / 1000)}s`);
  return parts.join(' ') + ' ago';
}
function formatHeader(runId, config, workspace) {
  const implBinary = config.implementers ? Object.keys(config.implementers)[0] : 'claude';
  const totalReviewers = config.reviewPhases?.reduce((sum, phase) => sum + phase.length, 0) ?? 0;
  const phaseInfo = (config.reviewPhases?.length ?? 0) > 1 ? ` in ${config.reviewPhases.length} phases` : '';
  console.log('');
  console.log(
    `  ${import_picocolors3.default.bold(import_picocolors3.default.cyan(`kloop ${runId}`))}  ${import_picocolors3.default.green('\u25CF')}  ${import_picocolors3.default.green('running')}`,
  );
  console.log(
    import_picocolors3.default.dim(`  implementer: ${implBinary}  \u2502  ${totalReviewers} reviewers${phaseInfo}`),
  );
  console.log(import_picocolors3.default.dim(`  workspace: ${workspace}`));
  console.log('');
}
function formatIterationStart(loopNum, maxIterations) {
  console.log(
    import_picocolors3.default.dim(
      `\u2500\u2500 iteration ${loopNum}/${maxIterations} ${'\u2500'.repeat(Math.max(1, 45 - String(loopNum).length - String(maxIterations).length))}`,
    ),
  );
}
function formatImplementerResult(binary, exitCode, durationMs) {
  const icon = exitCode === 0 ? import_picocolors3.default.green('\u2713') : import_picocolors3.default.red('\u2717');
  const color = exitCode === 0 ? import_picocolors3.default.green : import_picocolors3.default.red;
  console.log(
    `  ${icon} impl  ${binary}     ${color(`exit ${exitCode}`)}   ${import_picocolors3.default.dim(formatDuration(durationMs))}`,
  );
}
function formatReviewPhaseStart(phaseIdx, reviewers) {
  console.log('');
  console.log(import_picocolors3.default.dim(`  \u25C6 review phase ${phaseIdx} (${reviewers.length} reviewers)`));
}
function formatReviewerResult(reviewerIndex, binary, verdict, completionEstimate, durationMs) {
  const approved = verdict === 'approved';
  const icon = approved ? import_picocolors3.default.green('\u2713') : import_picocolors3.default.red('\u2717');
  const verdictColor = approved
    ? import_picocolors3.default.green('approved')
    : import_picocolors3.default.red('rejected');
  const completion = completionEstimate !== undefined ? `${String(completionEstimate).padStart(3)}%` : '    ';
  console.log(
    `  ${icon} rev-${reviewerIndex}  ${binary}    ${verdictColor}  ${import_picocolors3.default.dim(completion)}  ${import_picocolors3.default.dim(formatDuration(durationMs))}`,
  );
}
function formatConsensus(approved, verdictsList) {
  if (approved) {
    console.log(`  ${import_picocolors3.default.green('\u2713 consensus: approved')}`);
  } else {
    const approvedCount = verdictsList.filter(v => v.verdict === 'approved').length;
    const totalCount = verdictsList.length;
    console.log(
      `  ${import_picocolors3.default.red('\u2717 consensus: rejected')}  ${import_picocolors3.default.dim(`(${approvedCount}/${totalCount} approved)`)}`,
    );
  }
}
function formatFailure(consecutive, threshold) {
  console.log(import_picocolors3.default.dim(`  failures ${consecutive}/${threshold}`));
}
function formatCheckpointStart() {
  console.log(import_picocolors3.default.yellow('  \u25C6 conflict threshold reached, running checkpointer...'));
}
function formatCheckpointOutcome(outcome, detail) {
  switch (outcome) {
    case 'conflict_found':
      console.log(import_picocolors3.default.red('  \u2717 conflict detected'));
      if (detail) console.log(import_picocolors3.default.dim(`    ${detail}`));
      break;
    case 'spec_auto_fixed':
      console.log(import_picocolors3.default.yellow('  \u25C6 spec auto-fixed, reloading...'));
      break;
    case 'spec_compressed':
      console.log(import_picocolors3.default.yellow(`  \u25C6 spec compressed, reloading...`));
      break;
    case 'no_action':
      console.log(import_picocolors3.default.dim('  \u25C6 no action needed, continuing...'));
      break;
  }
}
function formatPhaseShortCircuit(phaseIdx, remaining) {
  console.log(
    import_picocolors3.default.dim(`  phase ${phaseIdx} rejection \u2192 skipping ${remaining} remaining phase(s)`),
  );
}
function formatApproval(loopNum) {
  console.log('');
  console.log(
    `  ${import_picocolors3.default.green(import_picocolors3.default.bold(`\u2713 approved after ${loopNum} iteration(s)`))}`,
  );
}
function formatMaxIterations(maxIterations) {
  console.log(import_picocolors3.default.yellow(`  max iterations reached (${maxIterations})`));
}
function formatAgentLaunch(role, label, binary, tmuxSession, logPath) {
  const roleLabel = role === 'impl' ? 'implementer' : role === 'reviewer' ? label : 'checkpointer';
  console.log(`  \u25B8 ${import_picocolors3.default.cyan(roleLabel)}  ${import_picocolors3.default.bold(binary)}`);
  console.log(import_picocolors3.default.dim(`    tmux: ${tmuxSession}`));
  console.log(import_picocolors3.default.dim(`    log:  ${logPath}`));
}
function formatImplementerFailure(error) {
  console.log(import_picocolors3.default.red(`  \u2717 implementer failed: ${error}`));
}
function formatConflict(summary) {
  console.log('');
  console.log(
    import_picocolors3.default.red(
      '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    ),
  );
  console.log(import_picocolors3.default.red(import_picocolors3.default.bold('  CONFLICT DETECTED')));
  console.log(
    import_picocolors3.default.red(
      '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    ),
  );
  for (const line of summary.split(`
`)) {
    console.log(import_picocolors3.default.red(`  ${line}`));
  }
  console.log(import_picocolors3.default.dim('  A conflict.md file has been generated.'));
  console.log(import_picocolors3.default.dim('  Please resolve the conflict and restart the loop.'));
  console.log(
    import_picocolors3.default.red(
      '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    ),
  );
  console.log('');
}
function formatProgress(estimates, allResults) {
  if (estimates.length === 0) return;
  const lowestEstimate = Math.min(...estimates);
  const lowestEstimateReviewer = allResults.find(r => r.completionEstimate === lowestEstimate);
  const reviewerInfo = lowestEstimateReviewer ? ` (rev-${lowestEstimateReviewer.reviewerIndex})` : '';
  const barWidth = 30;
  const filled = Math.round((lowestEstimate / 100) * barWidth);
  const empty = barWidth - filled;
  const bar =
    import_picocolors3.default.green('\u2588'.repeat(filled)) + import_picocolors3.default.dim('\u2591'.repeat(empty));
  console.log(`  progress  ${bar} ${lowestEstimate}%${reviewerInfo}`);
}

// src/agents/runner.ts
var KLOOP_BIN = `bun run ${process.argv[1]}`;
function buildAgentCommand(params) {
  const { binary, harness, promptFile, sessionId, logFile } = params;
  if (harness === 'claude') {
    return `cat "${promptFile}" | ${binary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  } else {
    return `cat "${promptFile}" | ${binary} --yolo --output-format stream-json -p "" 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  }
}

class AgentRunner {
  tmux;
  state;
  config;
  reviewerBinaries;
  checkpointerBinary;
  checkpointerHarness;
  constructor(tmux, state, config) {
    this.tmux = tmux;
    this.state = state;
    this.config = config;
    this.reviewerBinaries = config.reviewPhases.flat();
    const checkpointerConfig = parseConflictCheckerConfig(config.conflictChecker ?? getPrimaryImplementer(config));
    this.checkpointerBinary = checkpointerConfig.binary;
    this.checkpointerHarness = checkpointerConfig.harness;
  }
  selectImplementer() {
    return selectImplementer(this.config);
  }
  getSelectedImplementer() {
    return getPrimaryImplementer(this.config);
  }
  async ensureAgentDir(agentDirPath) {
    await fs4.mkdir(agentDirPath, { recursive: true });
    return path4.join(agentDirPath, 'log');
  }
  async runImplementer(params) {
    const { runId, iteration, dirHash, prompt, timeout, onStart } = params;
    const implementerBinaryName = this.selectImplementer();
    const parsedImpl = parseImplementerConfig(implementerBinaryName);
    if (onStart) await onStart(parsedImpl.binary);
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-impl`;
    const session = {
      id: sessionId,
      iteration,
      role: 'implementer',
      binary: parsedImpl.binary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const promptFile = await this.writePromptFile(sessionId, prompt);
    const implDir = paths.loopImplementerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(implDir);
    await fs4.writeFile(path4.join(implDir, 'prompt.md'), prompt, 'utf-8');
    const command = buildAgentCommand({
      binary: parsedImpl.binary,
      harness: parsedImpl.harness,
      promptFile,
      sessionId,
      logFile,
    });
    formatAgentLaunch('impl', 'implementer', parsedImpl.binary, tmuxSession, logFile);
    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    await this.cleanupPromptFile(promptFile);
    let learnings = '';
    try {
      learnings = await fs4.readFile(paths.runLearnings(runId), 'utf-8');
    } catch {}
    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);
    if (harnessSessionId) {
      session.harnessSessionId = harnessSessionId;
    } else if (parsedImpl.harness === 'claude') {
      session.harnessSessionId = sessionId;
    }
    await this.state.saveSession(session);
    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      learnings,
      binary: parsedImpl.binary,
      harness: parsedImpl.harness,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      harnessSessionId: session.harnessSessionId,
    };
  }
  async runReviewersPhase(params) {
    const { runId, iteration, dirHash, phaseIndex, reviewers, prompts, timeout, onReviewerEnd } = params;
    console.log(`  review phase ${phaseIndex} \u2014 ${reviewers.map(r => r.binary).join(', ')}`);
    const results = await Promise.all(
      prompts.map(async (p, ordinal) => {
        const reviewer = reviewers[ordinal] ?? reviewers[0];
        const result = await this.runReviewer({
          runId,
          iteration,
          dirHash,
          reviewerIndex: p.reviewerIndex,
          binary: reviewer.binary,
          harness: reviewer.harness,
          prompt: p.prompt,
          timeout,
          phaseIndex,
          ordinal: ordinal + 1,
          noVerdictAsFailure: reviewer.noVerdictAsFailure,
        });
        if (onReviewerEnd) {
          await onReviewerEnd(result);
        }
        return result;
      }),
    );
    const approved = results.filter(r => r.verdict === 'approved').length;
    const rejected = results.filter(r => r.verdict === 'rejected').length;
    console.log(`Phase ${phaseIndex} verdicts: ${approved} approved, ${rejected} rejected`);
    return results;
  }
  async runReviewers(params) {
    const { runId, iteration, dirHash, prompts, timeout } = params;
    const allReviewers = this.config.reviewPhases.flat().map(parseReviewerConfig);
    return this.runReviewersPhase({
      runId,
      iteration,
      dirHash,
      phaseIndex: 0,
      reviewers: allReviewers,
      prompts,
      timeout,
    });
  }
  async runReviewer(params) {
    const {
      runId,
      iteration,
      dirHash,
      reviewerIndex,
      binary,
      harness,
      prompt,
      timeout,
      phaseIndex,
      ordinal,
      noVerdictAsFailure,
    } = params;
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-rev-${reviewerIndex}`;
    const session = {
      id: sessionId,
      iteration,
      role: 'reviewer',
      reviewerIndex,
      binary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const promptFile = await this.writePromptFile(sessionId, prompt);
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const reviewerDir = path4.join(reviewsDir, `reviewer-${reviewerIndex}`);
    const logFile = await this.ensureAgentDir(reviewerDir);
    await fs4.writeFile(path4.join(reviewerDir, 'prompt.md'), prompt, 'utf-8');
    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });
    formatAgentLaunch('reviewer', `rev-${reviewerIndex}`, binary, tmuxSession, logFile);
    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    const verdictContent = await this.safeReadFile(path4.join(verdictsDir, `reviewer-${reviewerIndex}.json`));
    const reviewContent = await this.safeReadFile(path4.join(reviewsDir, `reviewer-${reviewerIndex}.md`));
    let error;
    const verdict = this.determineReviewerVerdict({
      verdictFileContent: verdictContent,
      reviewFileContent: reviewContent,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerBinary: binary,
      phaseIndex,
      noVerdictAsFailure: noVerdictAsFailure ?? true,
      onError: msg => {
        error = msg;
      },
    });
    let reasoning = '';
    let completionEstimate;
    if (verdictContent) {
      const parsed = parseVerdictFile(verdictContent);
      reasoning = parsed.reasoning;
      completionEstimate = parsed.completionEstimate;
    }
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    session.verdict = verdict;
    await this.copyReviewFiles(runId, iteration, reviewerIndex, reviewContent, verdictContent);
    await this.cleanupPromptFile(promptFile);
    const tokens = await extractTokensFromLog(logFile);
    const harnessSessionId = await extractHarnessSessionId(logFile);
    if (harnessSessionId) {
      session.harnessSessionId = harnessSessionId;
    } else if (harness === 'claude') {
      session.harnessSessionId = sessionId;
    }
    await this.state.saveSession(session);
    const icon = verdict === 'approved' ? '\u2713' : '\u2717';
    console.log(
      `  ${icon} Reviewer ${reviewerIndex} (${binary})${phaseIndex !== undefined ? ` (phase ${phaseIndex})` : ''}: ${verdict}${completionEstimate !== undefined ? ` (${completionEstimate}%)` : ''}`,
    );
    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary,
      harness,
      verdict,
      reasoning,
      completionEstimate,
      phaseIndex,
      ordinal,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      error,
      harnessSessionId: session.harnessSessionId,
    };
  }
  async runCheckpointer(params) {
    const { runId, iteration, dirHash, specPath, timeout } = params;
    const sessionId = generateId();
    const tmuxSession = `kloop-${runId}-${iteration}-checkpoint`;
    const binary = this.checkpointerBinary;
    const harness = this.checkpointerHarness;
    const session = {
      id: sessionId,
      iteration,
      role: 'checkpointer',
      binary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const checkpointerVars = {
      specPath,
      iteration: String(iteration),
      reviewsDir: paths.loopReviewsPath(runId, iteration),
      archivedReviewsPattern: `${paths.runPath(runId)}/loop-*/reviews/reviewer-*.md`,
      conflictFile: `${paths.runPath(runId)}/conflict.md`,
      checkpointResultFile: `${paths.loopCheckpointerPath(runId, iteration)}/checkpoint-result.json`,
    };
    const prompt = buildCheckpointerPrompt(
      this.config.prompts?.checkpointer,
      this.config.prompts?.checkpointerFull,
      checkpointerVars,
      this.config.compressSpec,
    );
    const promptFile = await this.writePromptFile(sessionId, prompt);
    const checkpointerDir = paths.loopCheckpointerPath(runId, iteration);
    const logFile = await this.ensureAgentDir(checkpointerDir);
    await fs4.writeFile(path4.join(checkpointerDir, 'prompt.md'), prompt, 'utf-8');
    const command = buildAgentCommand({
      binary,
      harness,
      promptFile,
      sessionId,
      logFile,
    });
    formatAgentLaunch('checkpoint', 'checkpoint', binary, tmuxSession, logFile);
    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });
    const checkpointResultPath = `${checkpointerDir}/checkpoint-result.json`;
    const checkpointResultContent = await this.safeReadFile(checkpointResultPath);
    let outcome = 'no_action';
    let summary = 'Unable to determine checkpoint status';
    let progressPercent;
    let completedCriteria;
    let remainingCriteria;
    if (checkpointResultContent) {
      try {
        const parsed = JSON.parse(checkpointResultContent);
        if (
          parsed.outcome === 'conflict_found' ||
          parsed.outcome === 'spec_auto_fixed' ||
          parsed.outcome === 'spec_compressed' ||
          parsed.outcome === 'no_action'
        ) {
          outcome = parsed.outcome;
        }
        summary = parsed.summary ?? 'No summary provided';
        progressPercent = parsed.progressPercent;
        completedCriteria = parsed.completedCriteria;
        remainingCriteria = parsed.remainingCriteria;
      } catch {
        console.log('Warning: Could not parse checkpoint result, assuming no action');
      }
    }
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    const harnessSessionId = await extractHarnessSessionId(logFile);
    if (harnessSessionId) {
      session.harnessSessionId = harnessSessionId;
    } else if (harness === 'claude') {
      session.harnessSessionId = sessionId;
    }
    await this.state.saveSession(session);
    await this.cleanupPromptFile(promptFile);
    const outcomeDisplay = {
      conflict_found: 'CONFLICT DETECTED',
      spec_auto_fixed: 'SPEC AUTO-FIXED',
      spec_compressed: 'SPEC COMPRESSED',
      no_action: 'No action needed',
    };
    console.log(
      `Checkpoint: ${outcomeDisplay[outcome]}${progressPercent !== undefined ? ` (${progressPercent}% progress)` : ''}`,
    );
    console.log(`  Summary: ${summary}`);
    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outcome,
      summary,
      progressPercent,
      completedCriteria,
      remainingCriteria,
      harnessSessionId: session.harnessSessionId,
    };
  }
  determineReviewerVerdict(params) {
    const {
      verdictFileContent,
      reviewFileContent,
      exitCode,
      timedOut,
      reviewerBinary,
      phaseIndex,
      noVerdictAsFailure,
      onError,
    } = params;
    const phaseStr = phaseIndex !== undefined ? ` (phase ${phaseIndex})` : '';
    if (verdictFileContent) {
      const parsed = parseVerdictFile(verdictFileContent);
      if (parsed.verdict) {
        return parsed.verdict;
      }
    }
    if (reviewFileContent) {
      const fromText = parseVerdictFromText(reviewFileContent);
      if (fromText) {
        return fromText;
      }
    }
    if (noVerdictAsFailure) {
      const reason = timedOut ? 'timed out' : exitCode !== 0 ? `exited with code ${exitCode}` : 'produced no verdict';
      console.log(`\u26A0 Reviewer "${reviewerBinary}"${phaseStr} ${reason} \u2014 treating as rejection`);
      onError(timedOut ? 'timeout' : exitCode !== 0 ? `exit_code_${exitCode}` : 'no_verdict');
      return 'rejected';
    } else {
      const reason = timedOut ? 'timed out' : exitCode !== 0 ? `exited with code ${exitCode}` : 'produced no verdict';
      console.log(`\u26A0 Reviewer "${reviewerBinary}"${phaseStr} ${reason} \u2014 treating as approval`);
      return 'approved';
    }
  }
  async writePromptFile(sessionId, prompt) {
    const tmpDir = '/tmp/kloop/prompts';
    await fs4.mkdir(tmpDir, { recursive: true });
    const promptFile = path4.join(tmpDir, `prompt-${sessionId}.txt`);
    await fs4.writeFile(promptFile, prompt, 'utf-8');
    return promptFile;
  }
  async cleanupPromptFile(promptFile) {
    try {
      await fs4.unlink(promptFile);
    } catch {}
  }
  async safeReadFile(filePath) {
    try {
      return await fs4.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
  async copyReviewFiles(runId, iteration, reviewerIndex, reviewContent, verdictContent) {
    const reviewsDir = paths.loopReviewsPath(runId, iteration);
    const verdictsDir = paths.loopVerdictsPath(runId, iteration);
    await fs4.mkdir(reviewsDir, { recursive: true });
    await fs4.mkdir(verdictsDir, { recursive: true });
    if (reviewContent) {
      await fs4.writeFile(path4.join(reviewsDir, `reviewer-${reviewerIndex}.md`), reviewContent, 'utf-8');
    }
    if (verdictContent) {
      await fs4.writeFile(path4.join(verdictsDir, `reviewer-${reviewerIndex}.json`), verdictContent, 'utf-8');
    }
  }
}

// src/loop/runner.ts
function formatDuration2(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}
function formatTokensShort(input, output) {
  const total = (input ?? 0) + (output ?? 0);
  if (total < 1000) return `${total}`;
  return `${(total / 1000).toFixed(1)}k`;
}
class ConflictError extends Error {
  summary;
  constructor(summary) {
    super(`Conflict detected: ${summary}`);
    this.summary = summary;
    this.name = 'ConflictError';
  }
}

class AgentFailureError extends Error {
  failureInfo;
  constructor(failureInfo) {
    super(
      `Agent failure: ${failureInfo.binary} ${failureInfo.error} in loop ${failureInfo.loop}, iteration ${failureInfo.iteration}`,
    );
    this.failureInfo = failureInfo;
    this.name = 'AgentFailureError';
  }
}

class LoopRunner {
  state;
  tmux;
  agentRunner;
  paths;
  constructor(state, tmux, agentRunner, paths2 = paths) {
    this.state = state;
    this.tmux = tmux;
    this.agentRunner = agentRunner;
    this.paths = paths2;
  }
  async runWithId(runId) {
    const YAML = await Promise.resolve().then(() => __toESM(require_dist(), 1));
    const { appendFile } = await import('fs/promises');
    const configPath = this.paths.runConfig(runId);
    const configContent = await fs5.readFile(configPath, 'utf-8');
    const config = YAML.parse(configContent);
    const specPath = this.paths.runSpec(runId);
    let specContent;
    try {
      specContent = await fs5.readFile(specPath, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${specPath}`);
    }
    const initialVersion = await nextSpecVersion(runId);
    await fs5.writeFile(this.paths.runSpecVersioned(runId, initialVersion), specContent, 'utf-8');
    await fs5.writeFile(specPath, specContent, 'utf-8');
    const dirHash = getDirHash(process.cwd());
    const implBinary = config.implementers ? Object.keys(config.implementers)[0] : 'claude';
    formatHeader(runId, config, process.cwd());
    const agentRunner = new AgentRunner(this.tmux, this.state, config);
    let loopNum = 0;
    let consecutiveFailures = 0;
    let checkpointRan = false;
    let learnings = [];
    const run = {
      id: runId,
      spec: specPath,
      status: 'running',
      iteration: 0,
      phase: 'implementing',
      startedAt: new Date().toISOString(),
      learnings: [],
      consecutiveFailures: 0,
    };
    const writeEvent = async event => {
      const line =
        JSON.stringify(event) +
        `
`;
      await appendFile(this.paths.runEvents(runId), line, 'utf-8');
    };
    try {
      while (loopNum < config.maxIterations) {
        loopNum++;
        await writeEvent({
          type: 'loop_start',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          implementer: implBinary,
        });
        const loopStartTime = Date.now();
        console.log('');
        formatIterationStart(loopNum, config.maxIterations);
        run.iteration = loopNum;
        run.phase = 'implementing';
        const iterData = buildIterationData(run, config, specPath, specContent, runId, loopNum, this.paths);
        const implResult = await agentRunner.runImplementer({
          runId,
          iteration: loopNum,
          dirHash,
          prompt: iterData.implementerPrompt,
          timeout: config.implementerTimeout,
          onStart: async binary => {
            await writeEvent({
              type: 'implementer_start',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              binary,
              harness: parseImplementerConfig(binary).harness,
            });
          },
        });
        formatImplementerResult(implResult.binary, implResult.exitCode, implResult.durationMs);
        const implError = implResult.timedOut
          ? 'timeout'
          : implResult.exitCode !== 0
            ? `exit_code_${implResult.exitCode}`
            : undefined;
        await writeEvent({
          type: 'implementer_end',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          binary: implResult.binary,
          harness: implResult.harness,
          exitCode: implResult.exitCode,
          durationMs: implResult.durationMs,
          ...(implError ? { error: implError } : {}),
        });
        if (implResult.timedOut || implResult.exitCode !== 0) {
          const implError2 = implResult.timedOut ? 'timeout' : `exit_code_${implResult.exitCode}`;
          formatImplementerFailure(implError2);
          const loopDurationMs2 = Date.now() - loopStartTime;
          await writeEvent({
            type: 'loop_end',
            timestamp: new Date().toISOString(),
            loop: loopNum,
            durationMs: loopDurationMs2,
          });
          consecutiveFailures++;
          formatFailure(consecutiveFailures, config.conflictCheckThreshold);
          if (consecutiveFailures >= config.conflictCheckThreshold) {
            formatCheckpointStart();
            checkpointRan = true;
            const cpBinary = config.conflictChecker ?? implBinary;
            const cpParsed = parseConflictCheckerConfig(cpBinary);
            await writeEvent({
              type: 'checkpoint_start',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              binary: cpParsed.binary,
              harness: cpParsed.harness,
            });
            const checkpointResult = await agentRunner.runCheckpointer({
              runId,
              iteration: loopNum,
              dirHash,
              specPath,
              specContent,
              timeout: config.reviewerTimeout,
            });
            await writeEvent({
              type: 'checkpoint_end',
              timestamp: new Date().toISOString(),
              loop: loopNum,
              outcome: checkpointResult.outcome,
              summary: checkpointResult.summary,
              progressPercent: checkpointResult.progressPercent,
              durationMs: checkpointResult.durationMs,
              exitCode: checkpointResult.exitCode,
            });
            switch (checkpointResult.outcome) {
              case 'conflict_found':
                await writeEvent({
                  type: 'conflict',
                  timestamp: new Date().toISOString(),
                  exitCode: 2,
                  summary: checkpointResult.summary,
                });
                await this.writeConflictMd(runId, checkpointResult.summary);
                throw new ConflictError(checkpointResult.summary);
              case 'spec_auto_fixed':
              case 'spec_compressed':
                if (!config.compressSpec) {
                  break;
                }
                specContent = await fs5.readFile(specPath, 'utf-8');
                await this.saveSpecVersion(runId, specContent);
                break;
              case 'no_action':
                break;
            }
            formatCheckpointOutcome(checkpointResult.outcome, checkpointResult.summary);
          }
          continue;
        }
        if (implResult.learnings) {
          learnings.push(
            ...implResult.learnings
              .split(
                `
`,
              )
              .filter(l => l.trim()),
          );
        }
        run.phase = 'reviewing';
        const allReviewerResults = await this.runPhasedReviewsForKloop(
          runId,
          agentRunner,
          config,
          loopNum,
          dirHash,
          iterData,
          writeEvent,
        );
        const verdictsList = allReviewerResults.map(r => ({
          reviewerIndex: r.reviewerIndex,
          verdict: r.verdict,
          binary: r.binary,
          phase: r.phaseIndex,
          error: r.error,
        }));
        const consensusResult = checkConsensus(
          verdictsList,
          config.reviewPhases?.length ?? 1,
          Math.max(1, ...allReviewerResults.map(r => (r.phaseIndex ?? 0) + 1)),
        );
        formatConsensus(consensusResult.approved, verdictsList);
        const estimates = allReviewerResults.map(r => r.completionEstimate).filter(e => e !== undefined);
        formatProgress(estimates, allReviewerResults);
        const loopDurationMs = Date.now() - loopStartTime;
        await writeEvent({
          type: 'loop_end',
          timestamp: new Date().toISOString(),
          loop: loopNum,
          durationMs: loopDurationMs,
        });
        await this.writeLoopSummary(runId, loopNum, implResult, allReviewerResults, loopDurationMs, config);
        await this.writeLoopMetrics(runId, loopNum, implResult, allReviewerResults, loopDurationMs);
        await this.writeEvidence(runId, loopNum);
        if (learnings.length > 0) {
          const learningsContent = learnings.map(l => `- ${l}`).join(`
`);
          await fs5.writeFile(
            this.paths.loopLearningMd(runId, loopNum),
            `# Loop ${loopNum} Learnings

${learningsContent}
`,
            'utf-8',
          );
          await fs5.writeFile(this.paths.runLearnings(runId), learningsContent, 'utf-8');
        }
        if (consensusResult.approved) {
          await writeEvent({
            type: 'completed',
            timestamp: new Date().toISOString(),
            exitCode: 0,
            reason: 'consensus',
          });
          formatApproval(loopNum);
          return {
            status: 'completed',
            finalRun: run,
            historyEntry: await this.buildHistoryEntryFromRun(run, config, 'completed', checkpointRan),
            checkpointRan,
          };
        }
        consecutiveFailures++;
        formatFailure(consecutiveFailures, config.conflictCheckThreshold);
        if (consecutiveFailures >= config.conflictCheckThreshold) {
          formatCheckpointStart();
          checkpointRan = true;
          const cpBinary = config.conflictChecker ?? implBinary;
          await writeEvent({
            type: 'checkpoint_start',
            timestamp: new Date().toISOString(),
            loop: loopNum,
            binary: cpBinary,
          });
          const checkpointResult = await agentRunner.runCheckpointer({
            runId,
            iteration: loopNum,
            dirHash,
            specPath,
            specContent,
            timeout: config.reviewerTimeout,
          });
          await writeEvent({
            type: 'checkpoint_end',
            timestamp: new Date().toISOString(),
            loop: loopNum,
            outcome: checkpointResult.outcome,
            summary: checkpointResult.summary,
            progressPercent: checkpointResult.progressPercent,
            durationMs: checkpointResult.durationMs,
            exitCode: checkpointResult.exitCode,
          });
          switch (checkpointResult.outcome) {
            case 'conflict_found':
              await writeEvent({
                type: 'conflict',
                timestamp: new Date().toISOString(),
                exitCode: 2,
                summary: checkpointResult.summary,
              });
              await this.writeConflictMd(runId, checkpointResult.summary);
              throw new ConflictError(checkpointResult.summary);
            case 'spec_auto_fixed':
              if (!config.compressSpec) {
                formatCheckpointOutcome('no_action');
                consecutiveFailures = 0;
                break;
              }
              formatCheckpointOutcome('spec_auto_fixed');
              specContent = await fs5.readFile(specPath, 'utf-8');
              await this.saveSpecVersion(runId, specContent);
              consecutiveFailures = 0;
              break;
            case 'spec_compressed':
              if (!config.compressSpec) {
                formatCheckpointOutcome('no_action');
                consecutiveFailures = 0;
                break;
              }
              formatCheckpointOutcome('spec_compressed', `${checkpointResult.progressPercent}% progress`);
              specContent = await fs5.readFile(specPath, 'utf-8');
              await this.saveSpecVersion(runId, specContent);
              consecutiveFailures = 0;
              break;
            case 'no_action':
              formatCheckpointOutcome('no_action');
              consecutiveFailures = 0;
              break;
          }
        }
      }
      await writeEvent({
        type: 'completed',
        timestamp: new Date().toISOString(),
        exitCode: 0,
        reason: 'max_iterations',
      });
      formatMaxIterations(config.maxIterations);
      return {
        status: 'max_iterations',
        finalRun: run,
        historyEntry: await this.buildHistoryEntryFromRun(run, config, 'completed', checkpointRan),
        checkpointRan,
      };
    } catch (error) {
      if (error instanceof AgentFailureError) {
        await this.writeFailureMd(runId, error.failureInfo);
        return {
          status: 'agent_failure',
          finalRun: run,
          historyEntry: await this.buildHistoryEntryFromRun(run, config, 'failed', checkpointRan),
          checkpointRan,
        };
      }
      if (error instanceof ConflictError) {
        formatConflict(error.summary);
        return {
          status: 'conflict',
          finalRun: run,
          historyEntry: await this.buildHistoryEntryFromRun(run, config, 'conflict', checkpointRan),
          checkpointRan,
        };
      }
      await writeEvent({
        type: 'error',
        timestamp: new Date().toISOString(),
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'failed',
        finalRun: run,
        historyEntry: await this.buildHistoryEntryFromRun(run, config, 'failed', checkpointRan),
        checkpointRan,
      };
    }
  }
  async runPhasedReviewsForKloop(runId, agentRunner, config, iterNum, dirHash, iterData, writeEvent) {
    const allResults = [];
    const reviewPhases = config.reviewPhases ?? [['claude-auto-zai']];
    let globalReviewerIndex = 0;
    const specPath = this.paths.runSpec(runId);
    for (let phaseIdx = 0; phaseIdx < reviewPhases.length; phaseIdx++) {
      const phaseReviewers = (reviewPhases[phaseIdx] ?? []).map(parseReviewerConfig);
      await writeEvent({
        type: 'review_phase_start',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: phaseIdx,
        reviewers: phaseReviewers.map(r => r.binary),
      });
      const reviewsDir = this.paths.loopReviewsPath(runId, iterNum);
      const verdictsDir = this.paths.loopVerdictsPath(runId, iterNum);
      const evidenceDir = this.paths.loopEvidencePath(runId, iterNum);
      const learningsFile = this.paths.runLearnings(runId);
      const prevLoop = iterNum > 1 ? iterNum - 1 : null;
      const phasePrompts = phaseReviewers.map((_, i) => {
        const seesPrevReviews = prevLoop !== null && Math.random() < (config.previousReviewPropagation ?? 0);
        const archivedReviews = seesPrevReviews ? this.paths.loopReviewsPath(runId, prevLoop) : null;
        return {
          reviewerIndex: globalReviewerIndex + i,
          prompt: buildReviewerPrompt(config.prompts?.reviewer, {
            specPath,
            iteration: String(iterNum),
            reviewerIndex: String(globalReviewerIndex + i),
            reviewsDir,
            verdictsDir,
            evidenceDir,
            learningsFile,
            archivedReviews,
          }),
          propagated: seesPrevReviews,
        };
      });
      for (const rc of phaseReviewers) {
        await writeEvent({
          type: 'reviewer_start',
          timestamp: new Date().toISOString(),
          loop: iterNum,
          phase: phaseIdx,
          reviewer: rc.binary,
          harness: rc.harness,
        });
      }
      const phaseResults = await agentRunner.runReviewersPhase({
        runId,
        iteration: iterNum,
        dirHash,
        phaseIndex: phaseIdx,
        reviewers: phaseReviewers,
        prompts: phasePrompts,
        timeout: config.reviewerTimeout,
        onReviewerEnd: async r => {
          const promptMeta = phasePrompts.find(p => p.reviewerIndex === r.reviewerIndex);
          const propagated = promptMeta?.propagated ?? false;
          r.propagated = propagated;
          await writeEvent({
            type: 'reviewer_end',
            timestamp: new Date().toISOString(),
            loop: iterNum,
            phase: phaseIdx,
            reviewer: r.binary,
            harness: r.harness,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            error: r.error,
            verdict: r.verdict,
            completionEstimate: r.completionEstimate,
            propagated,
          });
        },
      });
      allResults.push(...phaseResults);
      globalReviewerIndex += phaseReviewers.length;
      formatReviewPhaseStart(
        phaseIdx,
        phaseReviewers.map(r => r.binary),
      );
      for (const r of phaseResults) {
        formatReviewerResult(r.reviewerIndex, r.binary, r.verdict, r.completionEstimate, r.durationMs);
      }
      const anyRejected = phaseResults.some(r => r.verdict === 'rejected');
      await writeEvent({
        type: 'review_phase_end',
        timestamp: new Date().toISOString(),
        loop: iterNum,
        phase: phaseIdx,
        shortCircuited: anyRejected,
      });
      if (anyRejected) {
        const skipShortCircuit = iterNum === 1 && config.firstLoopFullReview;
        if (!skipShortCircuit) {
          if (reviewPhases.length > 1) {
            formatPhaseShortCircuit(phaseIdx, reviewPhases.length - phaseIdx - 1);
          }
          break;
        }
      }
    }
    return allResults;
  }
  async writeEvidence(runId, loopIndex) {
    const { execSync } = await import('child_process');
    const fsModule = await import('fs/promises');
    const evidenceDir = this.paths.loopEvidencePath(runId, loopIndex);
    await fsModule.mkdir(evidenceDir, { recursive: true });
    const workspace = process.cwd();
    try {
      const diff = execSync('git diff HEAD', { cwd: workspace, encoding: 'utf-8', timeout: 30000 });
      if (diff.trim()) {
        await fsModule.writeFile(path5.join(evidenceDir, 'diff.patch'), diff, 'utf-8');
      }
    } catch {}
    try {
      const diffNameOnly = execSync('git diff HEAD --name-only --diff-filter=ACMR', {
        cwd: workspace,
        encoding: 'utf-8',
        timeout: 30000,
      });
      const changedFiles = diffNameOnly
        .trim()
        .split(
          `
`,
        )
        .filter(f => f.trim());
      if (changedFiles.length > 0) {
        const filesData = [];
        for (const filePath of changedFiles.slice(0, 50)) {
          try {
            const fullPath = path5.join(workspace, filePath);
            const content = await fsModule.readFile(fullPath, 'utf-8');
            filesData.push({ path: filePath, content });
          } catch {
            filesData.push({ path: filePath, content: null });
          }
        }
        await fsModule.writeFile(path5.join(evidenceDir, 'files.json'), JSON.stringify(filesData, null, 2), 'utf-8');
      }
    } catch {}
  }
  async writeLoopSummary(runId, loopIndex, implResult, reviewerResults, durationMs, config) {
    const fsModule = await import('fs/promises');
    const summary = {
      loop: loopIndex,
      durationMs,
      implementer: {
        binary: implResult.binary,
        harness: implResult.harness,
        exitCode: implResult.exitCode,
        durationMs: implResult.durationMs,
        inputTokens: implResult.inputTokens,
        outputTokens: implResult.outputTokens,
      },
      reviewPhases: this.groupReviewersByPhase(reviewerResults),
    };
    await fsModule.mkdir(this.paths.loopPath(runId, loopIndex), { recursive: true });
    await fsModule.writeFile(this.paths.loopSummaryJson(runId, loopIndex), JSON.stringify(summary, null, 2), 'utf-8');
    let md = `# Loop ${loopIndex} Summary

`;
    md += `**Implementer:** ${implResult.binary} (${formatDuration2(implResult.durationMs)})
`;
    md += `**Result:** ${implResult.exitCode === 0 ? 'Approved' : 'Failed'}

`;
    const phases = this.groupReviewersByPhase(reviewerResults);
    for (const phase of phases) {
      md += `## Review Phase ${phase.phase}
`;
      md += `| Reviewer | Verdict | Time | Tokens | Completion |
`;
      md += `| -------- | ------- | ---- | ------ | ---------- |
`;
      for (const r of phase.reviewers) {
        const verdict = r.verdict === 'approved' ? 'Approved' : 'Rejected';
        const tokens = formatTokensShort(r.inputTokens, r.outputTokens);
        const completion = r.completionEstimate !== undefined ? `${r.completionEstimate}%` : '-';
        md += `| ${r.binary} | ${verdict} | ${formatDuration2(r.durationMs)} | ${tokens} | ${completion} |
`;
      }
      md += `
`;
    }
    await fsModule.writeFile(this.paths.loopSummaryMd(runId, loopIndex), md, 'utf-8');
  }
  async writeLoopMetrics(runId, loopIndex, implResult, reviewerResults, _loopDurationMs) {
    const fsModule = await import('fs/promises');
    const metricsPath = this.paths.loopMetrics(runId, loopIndex);
    const lines = [];
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        agent: 'implementer',
        event: 'end',
        binary: implResult.binary,
        harness: implResult.harness,
        inputTokens: implResult.inputTokens ?? 0,
        outputTokens: implResult.outputTokens ?? 0,
        durationMs: implResult.durationMs,
      }),
    );
    for (const r of reviewerResults) {
      lines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          agent: `reviewer-${r.reviewerIndex}`,
          event: 'end',
          binary: r.binary,
          harness: r.harness,
          phaseIdx: r.phaseIndex ?? 0,
          verdict: r.verdict,
          completionEstimate: r.completionEstimate,
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          durationMs: r.durationMs,
          error: r.error,
          propagated: r.propagated ?? false,
        }),
      );
    }
    await fsModule.writeFile(
      metricsPath,
      lines.join(`
`) +
        `
`,
      'utf-8',
    );
  }
  groupReviewersByPhase(results) {
    const byPhase = new Map();
    for (const r of results) {
      const phase = r.phaseIndex ?? 0;
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase).push(r);
    }
    return Array.from(byPhase.entries())
      .sort(([a], [b]) => a - b)
      .map(([phase, reviewers]) => ({
        phase,
        reviewers,
        shortCircuited: reviewers.some(r => r.verdict === 'rejected'),
      }));
  }
  async buildHistoryEntryFromRun(run, config, status, checkpointRan) {
    return {
      id: run.id,
      spec: run.spec,
      config,
      status,
      iterations: run.iteration,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      summary: [],
      checkpointRan,
    };
  }
  async writeConflictMd(runId, summary) {
    const fsModule = await import('fs/promises');
    const content = `# Conflict Detected

${summary}

## Next Steps
1. Review the conflict details above
2. Resolve the underlying issues
3. Restart the run with: kloop run ${runId}
`;
    await fsModule.writeFile(path5.join(this.paths.runPath(runId), 'conflict.md'), content, 'utf-8');
  }
  async saveSpecVersion(runId, specContent) {
    const version = await nextSpecVersion(runId);
    await fs5.writeFile(this.paths.runSpecVersioned(runId, version), specContent, 'utf-8');
    await fs5.writeFile(this.paths.runSpec(runId), specContent, 'utf-8');
  }
  async writeFailureMd(runId, info) {
    const content = `# Agent Failure

## What Failed
Implementer "${info.binary}" ${info.error}

## When
Loop ${info.loop}, iteration ${info.iteration}

## Next Steps
1. Investigate the log files in \`~/.kloop/{runId}/loop-{L}/\`
2. Check if the spec is achievable
3. Fix any configuration issues
4. Remove this file and restart: \`kloop run <id>\`
`;
    const { writeFile: writeFile6, mkdir: mkdir5 } = await import('fs/promises');
    const failurePath = runId ? path5.join(this.paths.runPath(runId), 'failure.md') : this.paths.failureMd;
    await mkdir5(path5.dirname(failurePath), { recursive: true });
    await writeFile6(failurePath, content, 'utf-8');
  }
}

// src/index-db.ts
import * as path6 from 'path';

// src/status/materialize.ts
var YAML = __toESM(require_dist(), 1);
async function materialize(runId, fs6, paths2 = paths, pid) {
  const statusPath = paths2.runStatus(runId);
  const eventsPath = paths2.runEvents(runId);
  let status = await loadStatus(statusPath, runId, fs6);
  const allLines = await readEventLines(eventsPath, fs6);
  const newStart = status.lastEventIndex;
  if (newStart < allLines.length) {
    for (let i = newStart; i < allLines.length; i++) {
      const line = allLines[i].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        applyEvent(status, event);
        status.lastEventIndex = i + 1;
        status.lastEventAt = event.timestamp;
      } catch {
        status.lastEventIndex = i + 1;
      }
    }
    await writeStatus(statusPath, status, fs6);
  }
  if (status.status === 'running' && pid !== undefined) {
    try {
      process.kill(pid, 0);
    } catch {
      status.status = 'crashed';
      status.exitCode = 1;
      status.exitReason = 'process terminated (SIGINT/SIGTERM or crash)';
      markRunningAgentsInterrupted(status, status.lastEventAt);
    }
  }
  if (status.status !== 'running' && status.status !== 'pending') {
    markRunningAgentsInterrupted(status, status.lastEventAt);
  }
  return status;
}
async function enrich(status, runId, fs6, paths2 = paths) {
  const enriched = structuredClone(status);
  for (const loop of enriched.loops) {
    let globalIdx = 0;
    for (const phase of loop.reviewPhases) {
      for (const reviewer of phase.reviewers) {
        if (!reviewer.verdict) {
          const verdictPath = paths2.loopVerdictsPath(runId, loop.loop) + `/reviewer-${globalIdx}.json`;
          try {
            const data = await fs6.readJson(verdictPath);
            if (data) {
              reviewer.verdict = data.approved === true ? 'approved' : data.approved === false ? 'rejected' : undefined;
              if (data.completionEstimate !== undefined) {
                reviewer.completionEstimate = data.completionEstimate;
              }
            }
          } catch {}
        }
        globalIdx++;
      }
    }
    if (loop.completedAt) {
      const summaryPath = paths2.loopSummaryJson(runId, loop.loop);
      try {
        const summary = await fs6.readJson(summaryPath);
        if (summary) {
          if (loop.implementer && summary.implementer) {
            loop.implementer.inputTokens = summary.implementer.inputTokens;
            loop.implementer.outputTokens = summary.implementer.outputTokens;
          }
          if (summary.reviewPhases) {
            for (const sp of summary.reviewPhases) {
              for (const sr of sp.reviewers) {
                let gIdx = 0;
                for (const phase of loop.reviewPhases) {
                  for (const reviewer of phase.reviewers) {
                    if (gIdx === sr.reviewerIndex) {
                      reviewer.inputTokens = sr.inputTokens;
                      reviewer.outputTokens = sr.outputTokens;
                    }
                    gIdx++;
                  }
                }
              }
            }
          }
        }
      } catch {}
    }
  }
  return enriched;
}
function applyEvent(status, event) {
  switch (event.type) {
    case EVENT_TYPES.RUN_START:
      status.status = 'running';
      status.startedAt = event.timestamp;
      status.config = event.config;
      status.failureThreshold = event.config?.conflictCheckThreshold ?? 3;
      break;
    case EVENT_TYPES.LOOP_START: {
      const loop = {
        loop: event.loop,
        startedAt: event.timestamp,
        implementer: {
          binary: event.implementer,
          status: 'pending',
        },
        reviewPhases: [],
      };
      status.loops.push(loop);
      break;
    }
    case EVENT_TYPES.IMPLEMENTER_START: {
      const loop = currentLoop(status);
      if (loop?.implementer) {
        loop.implementer.status = 'running';
        loop.implementer.startedAt = event.timestamp;
        loop.implementer.binary = event.binary;
        if ('harness' in event && event.harness) {
          loop.implementer.harness = event.harness;
        }
      }
      break;
    }
    case EVENT_TYPES.IMPLEMENTER_END: {
      const loop = findLoop(status, event.loop);
      if (loop?.implementer) {
        loop.implementer.status = event.exitCode === 0 ? 'completed' : 'error';
        loop.implementer.completedAt = event.timestamp;
        loop.implementer.exitCode = event.exitCode;
        loop.implementer.durationMs = event.durationMs;
        if ('harness' in event && event.harness) {
          loop.implementer.harness = event.harness;
        }
        if ('error' in event && event.error) {
          loop.implementer.error = event.error;
        }
      }
      break;
    }
    case EVENT_TYPES.REVIEW_PHASE_START: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        const phase = {
          phase: event.phase,
          startedAt: event.timestamp,
          reviewers: event.reviewers.map(binary => ({
            binary,
            status: 'pending',
          })),
        };
        loop.reviewPhases.push(phase);
      }
      break;
    }
    case EVENT_TYPES.REVIEWER_START: {
      const reviewer = findReviewer(status, event.loop, event.phase, event.reviewer);
      if (reviewer) {
        reviewer.status = 'running';
        reviewer.startedAt = event.timestamp;
        if ('harness' in event && event.harness) reviewer.harness = event.harness;
      }
      break;
    }
    case EVENT_TYPES.REVIEWER_END: {
      const reviewer = findReviewer(status, event.loop, event.phase, event.reviewer);
      if (reviewer) {
        reviewer.status = event.exitCode === 0 ? 'completed' : 'error';
        reviewer.completedAt = event.timestamp;
        reviewer.exitCode = event.exitCode;
        reviewer.durationMs = event.durationMs;
        if (event.error) reviewer.error = event.error;
        if (event.verdict) reviewer.verdict = event.verdict;
        if (event.completionEstimate !== undefined) reviewer.completionEstimate = event.completionEstimate;
        if (event.propagated !== undefined) reviewer.propagated = event.propagated;
        if ('harness' in event && event.harness) reviewer.harness = event.harness;
      }
      break;
    }
    case EVENT_TYPES.REVIEW_PHASE_END: {
      const loop = findLoop(status, event.loop);
      const phase = loop?.reviewPhases.find(p => p.phase === event.phase);
      if (phase) {
        phase.completedAt = event.timestamp;
        phase.shortCircuited = event.shortCircuited;
      }
      break;
    }
    case EVENT_TYPES.CHECKPOINT_START: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        loop.checkpoint = {
          binary: event.binary,
          status: 'running',
          startedAt: event.timestamp,
        };
      }
      break;
    }
    case EVENT_TYPES.CHECKPOINT:
    case EVENT_TYPES.CHECKPOINT_END: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        const existing = loop.checkpoint;
        loop.checkpoint = {
          binary: existing?.binary,
          status: 'completed',
          startedAt: existing?.startedAt ?? event.timestamp,
          completedAt: event.timestamp,
          outcome: event.outcome,
          summary: event.summary,
          progressPercent: 'progressPercent' in event ? event.progressPercent : undefined,
          durationMs: 'durationMs' in event ? event.durationMs : undefined,
          exitCode: 'exitCode' in event ? event.exitCode : undefined,
        };
      }
      break;
    }
    case EVENT_TYPES.LOOP_END: {
      const loop = findLoop(status, event.loop);
      if (loop) {
        loop.completedAt = event.timestamp;
        loop.durationMs = event.durationMs;
      }
      break;
    }
    case EVENT_TYPES.COMPLETED:
      status.status = 'completed';
      status.exitCode = event.exitCode;
      status.exitReason = event.reason;
      break;
    case EVENT_TYPES.CANCEL:
      status.status = 'cancelled';
      status.exitReason = event.reason;
      break;
    case EVENT_TYPES.STOP:
      status.status = 'cancelled';
      status.exitReason = event.reason;
      break;
    case EVENT_TYPES.ERROR:
      status.status = 'error';
      status.exitCode = 1;
      status.exitReason = event.message;
      break;
    case EVENT_TYPES.CONFLICT:
      status.status = 'conflict';
      status.exitCode = 2;
      status.exitReason = event.summary;
      break;
    case EVENT_TYPES.AGENT_FAILURE:
      status.status = 'agent_failure';
      status.exitCode = 3;
      status.exitReason = event.message;
      break;
    case EVENT_TYPES.CRASHED:
      status.status = 'crashed';
      status.exitCode = event.exitCode;
      status.exitReason = event.message;
      break;
  }
  const terminalTypes = [
    EVENT_TYPES.COMPLETED,
    EVENT_TYPES.CANCEL,
    EVENT_TYPES.STOP,
    EVENT_TYPES.ERROR,
    EVENT_TYPES.CONFLICT,
    EVENT_TYPES.AGENT_FAILURE,
    EVENT_TYPES.CRASHED,
  ];
  if (terminalTypes.includes(event.type)) {
    markRunningAgentsInterrupted(status, event.timestamp);
  }
  if (event.type === EVENT_TYPES.LOOP_END) {
    status.consecutiveFailures++;
  }
  if (event.type === EVENT_TYPES.COMPLETED && status.exitReason === 'consensus') {
    status.consecutiveFailures = Math.max(0, status.consecutiveFailures - 1);
  }
  if (event.type === EVENT_TYPES.CHECKPOINT || event.type === EVENT_TYPES.CHECKPOINT_END) {
    if (
      'outcome' in event &&
      (event.outcome === 'spec_auto_fixed' || event.outcome === 'spec_compressed' || event.outcome === 'no_action')
    ) {
      status.consecutiveFailures = 0;
    }
  }
}
function markRunningAgentsInterrupted(status, timestamp) {
  for (const loop of status.loops) {
    if (loop.implementer && (loop.implementer.status === 'running' || loop.implementer.status === 'pending')) {
      loop.implementer.status = 'error';
      loop.implementer.error = 'interrupted';
      loop.implementer.completedAt = timestamp;
      if (loop.implementer.startedAt) {
        loop.implementer.durationMs = new Date(timestamp).getTime() - new Date(loop.implementer.startedAt).getTime();
      }
    }
    for (const phase of loop.reviewPhases) {
      for (const reviewer of phase.reviewers) {
        if (reviewer.status === 'running' || reviewer.status === 'pending') {
          reviewer.status = 'error';
          reviewer.error = 'interrupted';
          reviewer.completedAt = timestamp;
          if (reviewer.startedAt) {
            reviewer.durationMs = new Date(timestamp).getTime() - new Date(reviewer.startedAt).getTime();
          }
        }
      }
    }
    if (loop.checkpoint?.status === 'running') {
      loop.checkpoint.status = 'completed';
      loop.checkpoint.completedAt = timestamp;
      loop.checkpoint.outcome = 'no_action';
    }
  }
}
function currentLoop(status) {
  return status.loops[status.loops.length - 1];
}
function findLoop(status, loopNum) {
  return status.loops.find(l => l.loop === loopNum);
}
function findReviewer(status, loopNum, phaseNum, binary) {
  const loop = findLoop(status, loopNum);
  const phase = loop?.reviewPhases.find(p => p.phase === phaseNum);
  return phase?.reviewers.find(r => r.binary === binary);
}
async function loadStatus(statusPath, runId, fs6) {
  try {
    if (await fs6.exists(statusPath)) {
      const content = await fs6.readFile(statusPath);
      const parsed = YAML.parse(content);
      if (parsed && typeof parsed.lastEventIndex === 'number') {
        return parsed;
      }
    }
  } catch {}
  return {
    lastEventIndex: 0,
    runId,
    workspace: '',
    status: 'pending',
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    consecutiveFailures: 0,
    failureThreshold: 3,
    loops: [],
  };
}
async function writeStatus(statusPath, status, fs6) {
  const { config, ...rest } = status;
  const content = YAML.stringify(rest, { lineWidth: 0 });
  await fs6.writeFile(statusPath, content);
}
async function readEventLines(eventsPath, fs6) {
  try {
    if (!(await fs6.exists(eventsPath))) return [];
    const content = await fs6.readFile(eventsPath);
    return content
      .split(
        `
`,
      )
      .filter(l => l.trim());
  } catch {
    return [];
  }
}
function toRunState(status) {
  const lastLoop = status.loops[status.loops.length - 1];
  let currentPhase;
  if (lastLoop) {
    if (lastLoop.completedAt) {
      currentPhase = 'completed';
    } else if (lastLoop.checkpoint?.status === 'running') {
      currentPhase = 'checkpointing';
    } else if (lastLoop.reviewPhases.length > 0) {
      currentPhase = 'reviewing';
    } else if (lastLoop.implementer?.status === 'running' || lastLoop.implementer?.status === 'pending') {
      currentPhase = 'implementing';
    } else if (lastLoop.implementer?.status === 'completed' || lastLoop.implementer?.status === 'error') {
      currentPhase = 'reviewing';
    }
  }
  if (status.status !== 'running' && status.status !== 'pending') {
    currentPhase = undefined;
  }
  return {
    runId: status.runId,
    workspace: status.workspace,
    status: status.status,
    exitCode: status.exitCode,
    exitReason: status.exitReason,
    currentLoop: lastLoop?.loop ?? 0,
    currentPhase,
    startedAt: status.startedAt,
    lastEventAt: status.lastEventAt,
    config: status.config,
  };
}

// src/index-db.ts
class IndexDb {
  fs;
  paths;
  db;
  constructor(fs6, paths2) {
    this.fs = fs6;
    this.paths = paths2;
    const { Database } = __require('bun:sqlite');
    this.fs.mkdir(path6.dirname(this.paths.indexDb));
    this.db = new Database(this.paths.indexDb, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id          TEXT PRIMARY KEY,
        workspace   TEXT NOT NULL,
        started_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
    `);
    this.db.exec('PRAGMA journal_mode=WAL');
  }
  async insertRun(row) {
    this.db
      .prepare('INSERT INTO runs (id, workspace, started_at) VALUES (?, ?, ?)')
      .run(row.id, row.workspace, row.started_at);
  }
  async getRun(runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    return row ? row : null;
  }
  async getRunByWorkspace(workspace) {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE workspace = ? ORDER BY started_at DESC LIMIT 1')
      .get(workspace);
    return row ? row : null;
  }
  async listRuns(workspace) {
    let query = 'SELECT * FROM runs';
    const params = [];
    if (workspace) {
      query += ' WHERE workspace = ?';
      params.push(workspace);
    }
    query += ' ORDER BY started_at DESC';
    const rows = this.db.prepare(query).all(...params);
    return rows;
  }
  async removeRun(runId) {
    const result = this.db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    return result.changes > 0;
  }
  close() {
    this.db.close();
  }
}

class EventLog {
  fs;
  paths;
  constructor(fs6, paths2) {
    this.fs = fs6;
    this.paths = paths2;
  }
  async append(runId, event) {
    const line =
      JSON.stringify(event) +
      `
`;
    const { appendFile } = await import('fs/promises');
    await appendFile(this.paths.runEvents(runId), line, 'utf-8');
  }
  async readAll(runId) {
    const filePath = this.paths.runEvents(runId);
    if (!(await this.fs.exists(filePath))) return [];
    const content = await this.fs.readFile(filePath);
    const events = [];
    for (const line of content.split(`
`)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {}
    }
    return events;
  }
  async deriveStatus(runId, pid) {
    const status = await materialize(runId, this.fs, this.paths, pid);
    return toRunState(status);
  }
  async materializeStatus(runId, pid) {
    return materialize(runId, this.fs, this.paths, pid);
  }
  async enrichStatus(status, runId) {
    return enrich(status, runId, this.fs, this.paths);
  }
  isTerminal(status) {
    return status !== 'running' && status !== 'pending';
  }
}

class PidLock {
  fs;
  paths;
  constructor(fs6, paths2) {
    this.fs = fs6;
    this.paths = paths2;
  }
  async acquire(runId, workspace) {
    const lockPath = this.paths.lockFile(runId);
    const info = {
      pid: process.pid,
      runId,
      workspace,
      createdAt: new Date().toISOString(),
    };
    await this.fs.writeJson(lockPath, info);
  }
  async read(runId) {
    const lockPath = this.paths.lockFile(runId);
    if (!(await this.fs.exists(lockPath))) return null;
    try {
      return await this.fs.readJson(lockPath);
    } catch {
      return null;
    }
  }
  async release(runId) {
    const lockPath = this.paths.lockFile(runId);
    if (await this.fs.exists(lockPath)) {
      await this.fs.unlink(lockPath);
    }
  }
  async isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  async listLocks() {
    const home = this.paths.kloopHome;
    if (!(await this.fs.exists(home))) return [];
    const files = await this.fs.readdir(home);
    const locks = [];
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const lockPath = `${home}/${file}`;
      try {
        const info = await this.fs.readJson(lockPath);
        if (info) locks.push(info);
      } catch {}
    }
    return locks;
  }
}
async function killRunTmuxSessions(tmux, runId) {
  const sessions = await tmux.listSessions();
  let killed = 0;
  for (const session of sessions) {
    const parsed = tmux.parseSessionName(session);
    if ((parsed && parsed.runId === runId) || session.includes(`kloop-${runId}`)) {
      if (await tmux.killSession(session)) {
        killed++;
      }
    }
  }
  return killed;
}
async function reapDeadRun(runId, eventLog, pidLock, tmux) {
  try {
    const killed = await killRunTmuxSessions(tmux, runId);
    if (killed > 0) {
      console.log(`  Cleaned up ${killed} stale tmux session(s)`);
    }
  } catch {}
  try {
    await eventLog.append(runId, {
      type: EVENT_TYPES.CRASHED,
      timestamp: new Date().toISOString(),
      exitCode: 1,
      signal: 'unknown',
      message: 'process terminated (detected dead PID)',
    });
  } catch {}
  try {
    await pidLock.release(runId);
  } catch {}
}

// src/cli/run.ts
var runLogStream = null;
async function startRunLogCapture(runId) {
  const logPath = paths.runLog(runId);
  const { mkdir: mkdir5, open } = await import('fs/promises');
  await mkdir5(paths.runPath(runId), { recursive: true });
  runLogStream = await open(logPath, 'a');
}
async function writeRunLog(msg) {
  if (runLogStream) {
    await runLogStream.write(
      msg +
        `
`,
    );
  }
}
async function stopRunLogCapture() {
  if (runLogStream) {
    await runLogStream.close();
    runLogStream = null;
  }
}
var _origConsoleLog = console.log;
var _origConsoleError = console.error;
function patchConsole(runId) {
  console.log = (...args) => {
    _origConsoleLog(...args);
    writeRunLog(args.map(String).join(' '));
  };
  console.error = (...args) => {
    _origConsoleError(...args);
    writeRunLog(args.map(String).join(' '));
  };
}
function unpatchConsole() {
  console.log = _origConsoleLog;
  console.error = _origConsoleError;
}
async function handler3(runId, opts, deps) {
  const { state, tmux, indexDb, eventLog, pidLock } = deps;
  const workspace = process.cwd();
  if (!runId) {
    const row = await indexDb.getRunByWorkspace(workspace);
    if (!row) {
      console.error('No run found for this workspace. Run kloop init first.');
      process.exit(1);
    }
    runId = row.id;
  }
  const lock = await pidLock.read(runId);
  const prevStatus = await eventLog.deriveStatus(runId, lock?.pid);
  if (lock && (await pidLock.isPidAlive(lock.pid))) {
    console.error(import_picocolors4.default.red(`Run ${runId} is still ${prevStatus?.status ?? 'running'}.`));
    console.error(import_picocolors4.default.dim('Cancel it first: kloop cancel'));
    process.exit(1);
  }
  if (prevStatus && eventLog.isTerminal(prevStatus.status)) {
    const oldId = runId;
    const newId = generateKloopRunId();
    const { mkdir: mkdir5, copyFile, writeFile: writeFile6 } = await import('fs/promises');
    const newRunDir = paths.runPath(newId);
    await mkdir5(newRunDir, { recursive: true });
    const oldConfigPath = paths.runConfig(oldId);
    const oldSpecPath = paths.runSpec(oldId);
    if (await deps.state.fs.exists(oldConfigPath)) {
      await copyFile(oldConfigPath, paths.runConfig(newId));
    }
    if (await deps.state.fs.exists(oldSpecPath)) {
      await copyFile(oldSpecPath, paths.runSpec(newId));
    }
    await writeFile6(paths.runEvents(newId), '', 'utf-8');
    await writeFile6(paths.runLearnings(newId), '', 'utf-8');
    await indexDb.insertRun({
      id: newId,
      workspace,
      started_at: new Date().toISOString(),
    });
    console.log(import_picocolors4.default.yellow(`Previous run ${oldId} ended: ${prevStatus.status}`));
    if (prevStatus.exitReason) {
      console.log(import_picocolors4.default.dim(`  ${prevStatus.exitReason}`));
    }
    console.log(import_picocolors4.default.dim(`Cloning into new run ${newId}...`));
    console.log('');
    runId = newId;
  }
  if (opts.detach) {
    const daemonSession = `kloop-${runId}-daemon`;
    if (await tmux.isSessionAlive(daemonSession)) {
      console.error(import_picocolors4.default.red(`Daemon session ${daemonSession} already exists.`));
      console.error(import_picocolors4.default.dim('Cancel or attach first: kloop cancel / kloop attach'));
      process.exit(1);
    }
    const entryPoint = process.argv[1];
    const command = `bun run "${entryPoint}" run ${runId}`;
    const { spawn } = await import('child_process');
    const child = spawn('tmux', ['new-session', '-d', '-s', daemonSession, '-c', workspace, command], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(import_picocolors4.default.green(`Detached: ${runId}`));
    console.log(import_picocolors4.default.dim(`  kloop status   \u2014 check progress`));
    console.log(import_picocolors4.default.dim(`  kloop logs     \u2014 view run log`));
    console.log(import_picocolors4.default.dim(`  kloop attach   \u2014 jump into tmux`));
    process.exitCode = 0;
    return;
  }
  await startRunLogCapture(runId);
  patchConsole(runId);
  try {
    await unlinkLocalKloop();
    const available = await tmux.isAvailable();
    if (!available) {
      console.error('Error: tmux is not installed');
      console.error('Install with: brew install tmux (macOS) or apt install tmux (Linux)');
      process.exit(1);
    }
    const runDir = paths.runPath(runId);
    if (!(await deps.state.fs.exists(runDir))) {
      console.error(`Error: Run directory not found: ${runDir}`);
      console.error(`Run: kloop init`);
      process.exit(1);
    }
    const configPath = paths.runConfig(runId);
    const specPath = paths.runSpec(runId);
    if (!(await deps.state.fs.exists(configPath))) {
      console.error(`Error: config.yaml not found: ${configPath}`);
      process.exit(1);
    }
    if (!(await deps.state.fs.exists(specPath))) {
      console.error(`Error: spec.md not found: ${specPath}`);
      process.exit(1);
    }
    let config;
    try {
      const YAML2 = await Promise.resolve().then(() => __toESM(require_dist(), 1));
      const configContent = await deps.state.fs.readFile(configPath);
      config = YAML2.parse(configContent);
    } catch (err) {
      console.error(`Error: Failed to parse config.yaml: ${err.message}`);
      process.exit(1);
    }
    await pidLock.acquire(runId, workspace);
    let cleanedUp = false;
    const cleanup = async signal => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await killRunTmuxSessions(tmux, runId);
        await eventLog.append(runId, {
          type: EVENT_TYPES.CANCEL,
          timestamp: new Date().toISOString(),
          reason: `received ${signal}`,
        });
        await pidLock.release(runId);
      } catch {}
      unpatchConsole();
      await stopRunLogCapture();
      process.exit(130);
    };
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    await eventLog.append(runId, {
      type: EVENT_TYPES.RUN_START,
      timestamp: new Date().toISOString(),
      config,
    });
    console.log(`KLOOP [${runId}]: Starting run in ${workspace}`);
    const agentRunner = new AgentRunner(tmux, state, config);
    const loopRunner = new LoopRunner(state, tmux, agentRunner, paths);
    const result = await loopRunner.runWithId(runId);
    console.log('');
    console.log(`Loop finished: ${result.status}`);
    await pidLock.release(runId);
    unpatchConsole();
    await stopRunLogCapture();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    if (result.status === 'conflict') {
      process.exit(2);
    }
    if (result.status === 'agent_failure') {
      process.exit(3);
    }
    if (result.status === 'failed') {
      process.exit(1);
    }
  } catch (err) {
    const error = err;
    try {
      await eventLog.append(runId, {
        type: EVENT_TYPES.ERROR,
        timestamp: new Date().toISOString(),
        exitCode: 1,
        message: error.message,
      });
    } catch {}
    try {
      await pidLock.release(runId);
    } catch {}
    unpatchConsole();
    await stopRunLogCapture();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    if (error.name === 'AgentFailureError') {
      console.log('');
      console.log('========================================');
      console.log('AGENT FAILURE');
      console.log('========================================');
      console.log(error.message);
      console.log('');
      console.log('A failure.md file has been generated.');
      console.log('Please resolve and restart the loop.');
      console.log('========================================');
      process.exit(3);
    }
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
async function unlinkLocalKloop() {
  const { stat, rm: rm2 } = await import('fs/promises');
  const localKloop = path7.join(process.cwd(), '.kloop');
  try {
    const s = await stat(localKloop);
    if (s.isSymbolicLink()) {
      await rm2(localKloop);
    } else if (s.isDirectory()) {
      await rm2(localKloop, { recursive: true });
    }
  } catch {}
}

// src/cli/ps.ts
var import_picocolors5 = __toESM(require_picocolors(), 1);
var import_cli_table3 = __toESM(require_table(), 1);
async function handler4(opts, deps) {
  try {
    const { indexDb, eventLog, pidLock, tmux } = deps;
    const runs = await listRuns(indexDb, eventLog, pidLock, tmux, opts.all, opts.workspace);
    if (opts.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }
    if (runs.length === 0) {
      console.log(import_picocolors5.default.yellow('No runs found.'));
      return;
    }
    const table = new import_cli_table3.default({
      head: ['RUN ID', 'WORKSPACE', 'STATUS', 'LOOP', 'VERDICT', 'AGE', 'DURATION'],
      style: { head: ['bold'], border: ['dim'] },
      chars: {
        top: '',
        'top-mid': '',
        'top-left': '',
        'top-right': '',
        bottom: '',
        'bottom-mid': '',
        'bottom-left': '',
        'bottom-right': '',
        mid: '',
        'left-mid': '',
        'mid-mid': '',
        'right-mid': '',
        left: '',
        right: '',
        middle: '  ',
      },
    });
    for (const run of runs) {
      const statusColor =
        run.status === 'running'
          ? import_picocolors5.default.green
          : run.status === 'pending'
            ? import_picocolors5.default.yellow
            : run.status === 'completed'
              ? import_picocolors5.default.blue
              : run.status === 'crashed'
                ? import_picocolors5.default.magenta
                : run.status === 'cancelled'
                  ? import_picocolors5.default.yellow
                  : import_picocolors5.default.red;
      const loopStr = run.maxIterations ? `${run.loop}/${run.maxIterations}` : String(run.loop);
      const durationStr = formatDurationHuman(run.elapsedMs);
      const ageStr = formatAgeHuman(new Date(run.startedAt));
      let verdictStr = '-';
      if (run.status === 'completed' && run.exitReason === 'consensus') {
        verdictStr = import_picocolors5.default.green('approved');
      } else if (run.status === 'completed' && run.exitReason === 'max_iterations') {
        verdictStr = import_picocolors5.default.red('max iterations');
      } else if (run.exitReason) {
        verdictStr = run.exitReason.length > 20 ? run.exitReason.slice(0, 17) + '\u2026' : run.exitReason;
      }
      let workspace = run.workspace;
      const home = process.env.HOME ?? '/home';
      if (workspace.startsWith(home)) {
        workspace = '~' + workspace.slice(home.length);
      }
      if (workspace.length > 20) {
        workspace = '\u2026' + workspace.slice(-19);
      }
      table.push([run.id, workspace, statusColor(run.status), loopStr, verdictStr, ageStr, durationStr]);
    }
    console.log(table.toString());
  } catch (err) {
    console.error(import_picocolors5.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function listRuns(indexDb, eventLog, pidLock, tmux, includeAll, workspace) {
  const rows = await indexDb.listRuns(workspace);
  const runs = [];
  for (const row of rows) {
    const lock = await pidLock.read(row.id);
    const state = await eventLog.deriveStatus(row.id, lock?.pid);
    if (!state) continue;
    let finalStatus = state.status;
    if (state.status === 'crashed') {
      await reapDeadRun(row.id, eventLog, pidLock, tmux);
      const updated = await eventLog.deriveStatus(row.id);
      if (updated) finalStatus = updated.status;
    }
    if (!includeAll && finalStatus !== 'running') {
      continue;
    }
    const startedAt = new Date(row.started_at);
    const isTerminal = finalStatus !== 'running' && finalStatus !== 'pending';
    const endTime = isTerminal && state.lastEventAt ? new Date(state.lastEventAt).getTime() : Date.now();
    const elapsedMs = endTime - startedAt.getTime();
    runs.push({
      id: row.id,
      workspace: row.workspace,
      status: finalStatus,
      loop: state.currentLoop,
      maxIterations: state.config?.maxIterations,
      phase: state.currentPhase,
      exitReason: state.exitReason,
      startedAt: row.started_at,
      elapsedMs,
      endedAt: isTerminal ? state.lastEventAt : undefined,
    });
  }
  return runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

// src/cli/status.ts
var import_picocolors6 = __toESM(require_picocolors(), 1);
function shortBinary(binary, harness) {
  if (harness && harness !== 'claude') return `${binary}:${harness}`;
  return binary;
}
function agentLabel(agent) {
  return shortBinary(agent.binary, agent.harness);
}
function formatDuration3(ms) {
  return formatDurationHuman(ms);
}
function statusMark(ok) {
  if (ok === undefined) return import_picocolors6.default.dim('\u25CB');
  return ok ? import_picocolors6.default.green('\u25CF') : import_picocolors6.default.red('\u25CF');
}
function verdictMark(verdict) {
  if (verdict === 'approved') return import_picocolors6.default.green('\u2713');
  if (verdict === 'rejected') return import_picocolors6.default.red('\u2717');
  return import_picocolors6.default.dim('\xB7');
}
var NAME_W = 10;
var ROLE_W = 8;
function fmtRow(role, name, dur, info) {
  return `  ${import_picocolors6.default.dim(role.padEnd(ROLE_W))}  ${name.padEnd(NAME_W)}  ${dur.padStart(8)}  ${info}`;
}
function agentDuration(agent) {
  if (agent.durationMs) return formatDuration3(agent.durationMs);
  if (agent.startedAt && agent.status === 'running') {
    return formatDuration3(Date.now() - new Date(agent.startedAt).getTime());
  }
  return '';
}
function agentOk(agent) {
  if (agent.status === 'completed') return agent.exitCode === 0;
  if (agent.status === 'error' || agent.status === 'timeout') return false;
  return;
}
function renderLoop(loop, multiPhase, dimmed) {
  const prefix = dimmed ? import_picocolors6.default.dim : s => s;
  if (loop.implementer) {
    const impl = loop.implementer;
    const errNote = impl.error ? import_picocolors6.default.yellow(` ${impl.error}`) : '';
    if (impl.status === 'running') {
      console.log(
        prefix(
          fmtRow(
            'impl',
            agentLabel(impl),
            agentDuration(impl),
            `${import_picocolors6.default.green('\u25CF')} running`,
          ),
        ),
      );
    } else if (impl.status === 'pending') {
      console.log(
        prefix(fmtRow('impl', import_picocolors6.default.dim('...'), '', import_picocolors6.default.dim('pending'))),
      );
    } else {
      const dot =
        impl.exitCode === 0 ? import_picocolors6.default.green('\u25CF') : import_picocolors6.default.red('\u25CF');
      console.log(prefix(fmtRow('impl', agentLabel(impl), agentDuration(impl), `${dot}${errNote}`)));
    }
  }
  for (const phase of loop.reviewPhases) {
    const role = multiPhase ? `phase ${phase.phase}` : 'review';
    for (const r of phase.reviewers) {
      const pct = r.completionEstimate !== undefined ? `${r.completionEstimate}%` : '';
      const errNote = r.error ? import_picocolors6.default.yellow(` ${r.error}`) : '';
      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration3(Date.now() - new Date(r.startedAt).getTime()) : '';
        const propMark = r.propagated ? import_picocolors6.default.cyan('*') : '';
        console.log(
          prefix(
            fmtRow(
              role,
              agentLabel(r),
              elapsed,
              `${import_picocolors6.default.dim(r.status)}${r.verdict ? `  ${verdictMark(r.verdict)}` : ''}${pct ? `  ${pct}` : ''}${propMark ? `  ${propMark}` : ''}`,
            ),
          ),
        );
      } else {
        const propMark = r.propagated ? import_picocolors6.default.cyan('*') : '';
        console.log(
          prefix(
            fmtRow(
              role,
              agentLabel(r),
              agentDuration(r),
              `${verdictMark(r.verdict)}  ${statusMark(agentOk(r))}${pct ? `  ${import_picocolors6.default.dim(pct)}` : ''}${errNote}${propMark ? `  ${propMark}` : ''}`,
            ),
          ),
        );
      }
    }
  }
  if (loop.checkpoint) {
    const ck = loop.checkpoint;
    if (ck.status === 'running') {
      console.log(import_picocolors6.default.dim(`  checkpoint: running...`));
    } else if (ck.outcome) {
      const ckColor =
        ck.outcome === 'conflict_found'
          ? import_picocolors6.default.red
          : ck.outcome === 'spec_auto_fixed'
            ? import_picocolors6.default.green
            : ck.outcome === 'spec_compressed'
              ? import_picocolors6.default.blue
              : import_picocolors6.default.dim;
      console.log(
        import_picocolors6.default.dim(
          `  checkpoint: ${ckColor(ck.outcome)}${ck.progressPercent !== undefined ? ` (${ck.progressPercent}%)` : ''}`,
        ),
      );
      if (ck.summary) console.log(import_picocolors6.default.dim(`    ${ckColor(ck.summary)}`));
    }
  }
}
async function handler5(id, opts, deps) {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;
    let runId = id;
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(import_picocolors6.default.yellow('No active run for this workspace.'));
        return;
      }
      runId = row.id;
    }
    const lock = await pidLock.read(runId);
    const matStatus = await eventLog.materializeStatus(runId, lock?.pid);
    if (matStatus.status === 'crashed') {
      await reapDeadRun(runId, deps.eventLog, deps.pidLock, deps.tmux);
    }
    const status = await eventLog.enrichStatus(matStatus, runId);
    const elapsedMs = Date.now() - new Date(status.startedAt).getTime();
    let config;
    try {
      const YAML2 = await Promise.resolve().then(() => __toESM(require_dist(), 1));
      const configContent = await state.fs.readFile(paths.runConfig(runId));
      config = YAML2.parse(configContent);
    } catch {}
    if (opts.json) {
      const latestLoops = status.loops.slice(-2);
      console.log(
        JSON.stringify(
          {
            id: runId,
            status: status.status,
            loop: status.loops.length > 0 ? status.loops[status.loops.length - 1].loop : 0,
            maxIterations: config?.maxIterations,
            compressSpec: config?.compressSpec,
            startedAt: status.startedAt,
            elapsedMs,
            exitCode: status.exitCode,
            exitReason: status.exitReason,
            failures: status.consecutiveFailures,
            failureThreshold: status.failureThreshold,
            loops: latestLoops,
          },
          null,
          2,
        ),
      );
      return;
    }
    const statusColor =
      status.status === 'running'
        ? import_picocolors6.default.green
        : status.status === 'completed'
          ? import_picocolors6.default.blue
          : status.status === 'cancelled'
            ? import_picocolors6.default.yellow
            : status.status === 'crashed'
              ? import_picocolors6.default.magenta
              : import_picocolors6.default.red;
    const isRunning = status.status === 'running';
    const lastLoop = status.loops[status.loops.length - 1];
    const currentLoop1 = lastLoop?.loop ?? 0;
    const maxLoop = config?.maxIterations ?? '?';
    const multiPhase = config?.reviewPhases?.length > 1;
    const startedDate = new Date(status.startedAt);
    const ageStr = formatAgeHuman(startedDate);
    const durStr = formatDurationHuman(elapsedMs);
    if (isRunning) {
      console.log(import_picocolors6.default.bold(`Run: ${runId}  ${statusColor(`[${status.status.toUpperCase()}]`)}`));
      console.log(`  started ${ageStr}  (running for ${durStr})`);
    } else {
      const completedAge = status.lastEventAt ? formatAgeHuman(new Date(status.lastEventAt)) : '';
      console.log(import_picocolors6.default.bold(`Run: ${runId}  ${statusColor(`[${status.status.toUpperCase()}]`)}`));
      console.log(`  started ${format(startedDate, 'MMM dd, HH:mm')}`);
      console.log(
        `  ran for ${durStr}${completedAge ? import_picocolors6.default.dim(`  completed ${completedAge}`) : ''}`,
      );
    }
    if (status.status === 'conflict') {
      console.log(import_picocolors6.default.red(`  CONFLICT: ${status.exitReason ?? 'unknown'}`));
      const conflictPath = `${paths.runPath(runId)}/conflict.md`;
      console.log(import_picocolors6.default.dim(`  See conflict details: ${conflictPath}`));
      console.log(import_picocolors6.default.dim('  Resolve the conflict, then run: kloop run'));
    } else if (status.exitReason) {
      const verdictLabel =
        status.exitReason === 'consensus'
          ? import_picocolors6.default.green('all reviewers approved')
          : status.exitReason === 'max_iterations'
            ? import_picocolors6.default.red('max iterations reached')
            : import_picocolors6.default.dim(status.exitReason);
      console.log(`  ${verdictLabel}`);
    }
    console.log('');
    if (config) {
      const impls = Object.entries(config.implementers);
      const implStr = impls.map(([b, w]) => (w > 1 ? `${shortBinary(b)}:${w}` : shortBinary(b))).join(', ');
      const phases = config.reviewPhases;
      const phaseCount = phases?.length ?? 1;
      const revCount = phases?.flat().length ?? 0;
      const compressLabel = config.compressSpec ? 'on' : 'off';
      console.log(
        import_picocolors6.default.dim(
          `Impl: ${implStr}  |  ${revCount} reviewers in ${phaseCount} phase${phaseCount > 1 ? 's' : ''}  |  max ${config.maxIterations} loops  |  compress: ${compressLabel}`,
        ),
      );
      console.log('');
    }
    const failColor =
      status.consecutiveFailures >= status.failureThreshold
        ? import_picocolors6.default.red
        : status.consecutiveFailures > 0
          ? import_picocolors6.default.yellow
          : import_picocolors6.default.dim;
    console.log(
      import_picocolors6.default.dim(
        `Failures: ${failColor(`${status.consecutiveFailures} / ${status.failureThreshold}`)}`,
      ),
    );
    if (lastLoop) {
      let phaseLabel = '';
      if (isRunning) {
        if (lastLoop.checkpoint?.status === 'running') {
          phaseLabel = import_picocolors6.default.dim('  checkpointing');
        } else if (lastLoop.reviewPhases.length > 0 && !lastLoop.completedAt) {
          phaseLabel = import_picocolors6.default.dim('  reviewing');
        } else if (
          lastLoop.implementer &&
          (lastLoop.implementer.status === 'running' || lastLoop.implementer.status === 'pending')
        ) {
          phaseLabel = import_picocolors6.default.dim('  implementing');
        }
      }
      let currentElapsed = '';
      if (lastLoop.durationMs) {
        currentElapsed = import_picocolors6.default.dim(`  ${formatDuration3(lastLoop.durationMs)}`);
      } else if (lastLoop.startedAt) {
        currentElapsed = import_picocolors6.default.dim(
          `  ${formatDuration3(Date.now() - new Date(lastLoop.startedAt).getTime())}`,
        );
      }
      console.log('');
      console.log(
        import_picocolors6.default.bold(`Iteration ${currentLoop1} / ${maxLoop}${phaseLabel}${currentElapsed}`),
      );
      renderLoop(lastLoop, multiPhase, false);
    }
    if (status.loops.length >= 2) {
      const prev = status.loops[status.loops.length - 2];
      console.log('');
      console.log(
        import_picocolors6.default.dim(
          `Previous \u2014 Iteration ${prev.loop}  ${prev.durationMs ? formatDuration3(prev.durationMs) : ''}`,
        ),
      );
      renderLoop(prev, multiPhase, true);
    }
    console.log('');
    const learningsPath = paths.runLearnings(runId);
    if (await state.fs.exists(learningsPath)) {
      const content = await state.fs.readFile(learningsPath);
      const lines = content
        .split(
          `
`,
        )
        .filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        console.log(import_picocolors6.default.cyan(`Learnings (${lines.length}):`));
        for (let i = 0; i < Math.min(3, lines.length); i++) {
          console.log(
            `  ${import_picocolors6.default.dim(`${i + 1}.`)} ${lines[i].replace(/^[-*]\s*/, '').slice(0, 70)}`,
          );
        }
        if (lines.length > 3) {
          console.log(import_picocolors6.default.dim(`  ... and ${lines.length - 3} more`));
        }
        console.log('');
      }
    }
    console.log(import_picocolors6.default.dim('kloop describe | kloop view | kloop logs | kloop metrics'));
  } catch (err) {
    console.error(import_picocolors6.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/describe.ts
var import_picocolors7 = __toESM(require_picocolors(), 1);
function shortBinary2(binary, harness) {
  if (harness && harness !== 'claude') return `${binary}:${harness}`;
  return binary;
}
function agentLabel2(agent) {
  return shortBinary2(agent.binary, agent.harness);
}
function formatDuration4(ms) {
  return formatDurationHuman(ms);
}
function formatTokens(input, output) {
  if (!input && !output) return '';
  const total = (input ?? 0) + (output ?? 0);
  if (total < 1000) return `${total}`;
  return `${(total / 1000).toFixed(1)}k`;
}
function statusMark2(ok) {
  if (ok === undefined) return import_picocolors7.default.dim('\u25CB');
  return ok ? import_picocolors7.default.green('\u25CF') : import_picocolors7.default.red('\u25CF');
}
function verdictMark2(verdict) {
  if (verdict === 'approved') return import_picocolors7.default.green('\u2713');
  if (verdict === 'rejected') return import_picocolors7.default.red('\u2717');
  return import_picocolors7.default.dim('\xB7');
}
var NAME_W2 = 10;
var ROLE_W2 = 10;
function fmtRow2(role, name, dur, info) {
  return `  ${import_picocolors7.default.dim(role.padEnd(ROLE_W2))}  ${name.padEnd(NAME_W2)}  ${dur.padStart(8)}  ${info}`;
}
function agentDuration2(agent) {
  if (agent.durationMs) return formatDuration4(agent.durationMs);
  if (agent.startedAt && agent.status === 'running') {
    return formatDuration4(Date.now() - new Date(agent.startedAt).getTime());
  }
  return '';
}
function agentOk2(agent) {
  if (agent.status === 'completed') return agent.exitCode === 0;
  if (agent.status === 'error' || agent.status === 'timeout') return false;
  return;
}
function renderLoopFull(loop, multiPhase) {
  if (loop.implementer) {
    const impl = loop.implementer;
    const implTok = formatTokens(impl.inputTokens, impl.outputTokens);
    const errNote = impl.error ? import_picocolors7.default.yellow(` ${impl.error}`) : '';
    if (impl.status === 'running') {
      console.log(
        fmtRow2(
          'impl',
          agentLabel2(impl),
          agentDuration2(impl),
          `${import_picocolors7.default.green('\u25CF')} running`,
        ),
      );
    } else if (impl.status === 'pending') {
      console.log(
        fmtRow2('impl', import_picocolors7.default.dim('...'), '', import_picocolors7.default.dim('pending')),
      );
    } else {
      const dot =
        impl.exitCode === 0 ? import_picocolors7.default.green('\u25CF') : import_picocolors7.default.red('\u25CF');
      console.log(
        fmtRow2(
          'impl',
          agentLabel2(impl),
          agentDuration2(impl),
          `${dot}${implTok ? `  ${import_picocolors7.default.dim(implTok + ' tok')}` : ''}${errNote}`,
        ),
      );
    }
  }
  for (const phase of loop.reviewPhases) {
    const role = multiPhase ? `phase ${phase.phase}` : 'review';
    for (const r of phase.reviewers) {
      const pct = r.completionEstimate !== undefined ? `${r.completionEstimate}%` : '';
      const tok = formatTokens(r.inputTokens, r.outputTokens);
      const errNote = r.error ? import_picocolors7.default.yellow(` ${r.error}`) : '';
      if (r.status === 'running' || r.status === 'pending') {
        const elapsed = r.startedAt ? formatDuration4(Date.now() - new Date(r.startedAt).getTime()) : '';
        console.log(
          fmtRow2(
            role,
            agentLabel2(r),
            elapsed,
            `${import_picocolors7.default.dim(r.status)}${r.verdict ? `  ${verdictMark2(r.verdict)}` : ''}${pct ? `  ${pct}` : ''}`,
          ),
        );
      } else {
        console.log(
          fmtRow2(
            role,
            agentLabel2(r),
            agentDuration2(r),
            `${verdictMark2(r.verdict)}  ${statusMark2(agentOk2(r))}${pct ? `  ${import_picocolors7.default.dim(pct)}` : ''}${tok ? `  ${import_picocolors7.default.dim(tok + ' tok')}` : ''}${errNote}`,
          ),
        );
      }
    }
  }
  if (loop.checkpoint) {
    const ck = loop.checkpoint;
    if (ck.status === 'running') {
      console.log(`  checkpoint: ${import_picocolors7.default.dim('running...')}`);
    } else if (ck.outcome) {
      const ckColor =
        ck.outcome === 'conflict_found'
          ? import_picocolors7.default.red
          : ck.outcome === 'spec_auto_fixed'
            ? import_picocolors7.default.green
            : ck.outcome === 'spec_compressed'
              ? import_picocolors7.default.blue
              : import_picocolors7.default.dim;
      console.log(
        `  checkpoint: ${ckColor(ck.outcome)}${ck.progressPercent !== undefined ? ` (${ck.progressPercent}%)` : ''}`,
      );
      if (ck.summary) console.log(`    ${ckColor(ck.summary)}`);
    }
  }
}
async function handler6(runId, opts, deps) {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;
    if (!runId) {
      const workspace = process.cwd();
      const row2 = await indexDb.getRunByWorkspace(workspace);
      if (!row2) {
        console.log(import_picocolors7.default.yellow('No run found for this workspace.'));
        return;
      }
      runId = row2.id;
    }
    const row = await indexDb.getRun(runId);
    if (!row) {
      console.log(import_picocolors7.default.red(`Run not found: ${runId}`));
      return;
    }
    const lock = await pidLock.read(runId);
    const matStatus = await eventLog.materializeStatus(runId, lock?.pid);
    const status = await eventLog.enrichStatus(matStatus, runId);
    const elapsedMs = Date.now() - new Date(status.startedAt).getTime();
    let config;
    try {
      const YAML2 = await Promise.resolve().then(() => __toESM(require_dist(), 1));
      const configContent = await state.fs.readFile(paths.runConfig(runId));
      config = YAML2.parse(configContent);
    } catch {}
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            id: runId,
            workspace: row.workspace,
            status: status.status,
            loop: status.loops.length > 0 ? status.loops[status.loops.length - 1].loop : 0,
            maxIterations: config?.maxIterations,
            compressSpec: config?.compressSpec,
            startedAt: status.startedAt,
            elapsedMs,
            exitCode: status.exitCode,
            exitReason: status.exitReason,
            failures: status.consecutiveFailures,
            failureThreshold: status.failureThreshold,
            loops: status.loops,
            lastEventIndex: status.lastEventIndex,
          },
          null,
          2,
        ),
      );
      return;
    }
    const statusColor =
      status.status === 'running'
        ? import_picocolors7.default.green
        : status.status === 'completed'
          ? import_picocolors7.default.blue
          : status.status === 'cancelled'
            ? import_picocolors7.default.yellow
            : status.status === 'crashed'
              ? import_picocolors7.default.magenta
              : import_picocolors7.default.red;
    const isRunning = status.status === 'running';
    const maxLoop = config?.maxIterations ?? '?';
    const multiPhase = config?.reviewPhases?.length > 1;
    const startedDate = new Date(status.startedAt);
    const ageStr = formatAgeHuman(startedDate);
    const durStr = formatDurationHuman(elapsedMs);
    if (isRunning) {
      console.log(import_picocolors7.default.bold(`Run: ${runId}  ${statusColor(`[${status.status.toUpperCase()}]`)}`));
      console.log(`  started ${ageStr}  (running for ${durStr})`);
    } else {
      const completedAge = status.lastEventAt ? formatAgeHuman(new Date(status.lastEventAt)) : '';
      console.log(import_picocolors7.default.bold(`Run: ${runId}  ${statusColor(`[${status.status.toUpperCase()}]`)}`));
      console.log(`  started ${format(startedDate, 'MMM dd, HH:mm')}`);
      console.log(
        `  ran for ${durStr}${completedAge ? import_picocolors7.default.dim(`  completed ${completedAge}`) : ''}`,
      );
    }
    if (status.status === 'conflict') {
      console.log(import_picocolors7.default.red(`  CONFLICT: ${status.exitReason ?? 'unknown'}`));
      const conflictPath = `${paths.runPath(runId)}/conflict.md`;
      console.log(import_picocolors7.default.dim(`  See conflict details: ${conflictPath}`));
      console.log(import_picocolors7.default.dim('  Resolve the conflict, then run: kloop run'));
    } else if (status.exitReason) {
      const verdictLabel =
        status.exitReason === 'consensus'
          ? import_picocolors7.default.green('all reviewers approved')
          : status.exitReason === 'max_iterations'
            ? import_picocolors7.default.red('max iterations reached')
            : import_picocolors7.default.dim(status.exitReason);
      console.log(`  ${verdictLabel}`);
    }
    console.log('');
    if (config) {
      console.log(import_picocolors7.default.cyan('Config:'));
      const implEntries = Object.entries(config.implementers);
      if (implEntries.length === 1) {
        console.log(`  Implementer: ${shortBinary2(implEntries[0][0])}`);
      } else {
        for (const [binary, weight] of implEntries) {
          console.log(`    ${shortBinary2(binary)} (weight: ${weight})`);
        }
      }
      const phases = config.reviewPhases;
      const fmtReviewer = raw => {
        const p = parseReviewerConfig(raw);
        return shortBinary2(p.binary, p.harness);
      };
      if (phases?.length === 1) {
        console.log(`  Reviewers:   ${phases[0].map(fmtReviewer).join(', ')}`);
      } else if (phases) {
        for (let i = 0; i < phases.length; i++) {
          console.log(`    Phase ${i}:    ${phases[i].map(fmtReviewer).join(', ')}`);
        }
      }
      const compressLabel = config.compressSpec ? 'on' : 'off';
      console.log(
        `  Max: ${config.maxIterations} loops | Impl: ${config.implementerTimeout}m | Rev: ${config.reviewerTimeout}m | Compress: ${compressLabel}`,
      );
      console.log('');
    }
    const failColor =
      status.consecutiveFailures >= status.failureThreshold
        ? import_picocolors7.default.red
        : status.consecutiveFailures > 0
          ? import_picocolors7.default.yellow
          : import_picocolors7.default.dim;
    console.log(`Failures: ${failColor(`${status.consecutiveFailures} / ${status.failureThreshold}`)}`);
    console.log('');
    for (const loop of status.loops) {
      const isCurrent = loop === status.loops[status.loops.length - 1] && isRunning;
      const prefix = isCurrent ? '' : import_picocolors7.default.dim('Previous \u2014 ');
      console.log(
        isCurrent
          ? import_picocolors7.default.bold(
              `Iteration ${loop.loop}  ${loop.durationMs ? formatDuration4(loop.durationMs) : ''}`,
            )
          : `${prefix}${import_picocolors7.default.dim(`Iteration ${loop.loop}  ${loop.durationMs ? formatDuration4(loop.durationMs) : ''}`)}`,
      );
      renderLoopFull(loop, multiPhase);
      console.log('');
    }
    if (status.loops.length > 0 && !isRunning) {
      const lastLoop = status.loops[status.loops.length - 1];
      const allApproved = lastLoop.reviewPhases.every(p => p.reviewers.every(r => r.verdict === 'approved'));
      const estimates = [];
      for (const phase of lastLoop.reviewPhases) {
        for (const r of phase.reviewers) {
          if (r.completionEstimate !== undefined) estimates.push(r.completionEstimate);
        }
      }
      const avgCompletion =
        estimates.length > 0 ? Math.round(estimates.reduce((a, b) => a + b, 0) / estimates.length) : undefined;
      if (allApproved) {
        console.log(
          `Final verdict: ${import_picocolors7.default.green('APPROVED')}${avgCompletion !== undefined ? `  (avg ${avgCompletion}% completion)` : ''}`,
        );
      } else {
        const verdictLabel = status.exitReason === 'max_iterations' ? 'REJECTED (max iterations)' : 'REJECTED';
        console.log(
          `Final verdict: ${import_picocolors7.default.red(verdictLabel)}${avgCompletion !== undefined ? `  (avg ${avgCompletion}% completion)` : ''}`,
        );
      }
      console.log('');
    }
    const learningsPath = paths.runLearnings(runId);
    if (await state.fs.exists(learningsPath)) {
      const content = await state.fs.readFile(learningsPath);
      const lines = content
        .split(
          `
`,
        )
        .filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length > 0) {
        console.log(import_picocolors7.default.cyan(`Learnings (${lines.length}):`));
        for (let i = 0; i < Math.min(5, lines.length); i++) {
          console.log(
            `  ${import_picocolors7.default.dim(`${i + 1}.`)} ${lines[i].replace(/^[-*]\s*/, '').slice(0, 70)}`,
          );
        }
        if (lines.length > 5) {
          console.log(import_picocolors7.default.dim(`  ... and ${lines.length - 5} more`));
        }
        console.log('');
      }
    }
    console.log(import_picocolors7.default.dim('kloop status | kloop view | kloop logs | kloop metrics'));
  } catch (err) {
    console.error(import_picocolors7.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/metrics.ts
var import_picocolors8 = __toESM(require_picocolors(), 1);
var CLAUDE_AUTO_PREFIX = 'claude-auto-';
function shortBinary3(binary, harness) {
  const name = binary.startsWith(CLAUDE_AUTO_PREFIX) ? binary.slice(CLAUDE_AUTO_PREFIX.length) : binary;
  if (harness && harness !== 'claude') return `${name}:${harness}`;
  return name;
}
function formatDuration5(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}
function derivePhase(agent) {
  if (agent === 'implementer') return 'impl';
  if (agent === 'reviewer') return 'review';
  if (agent === 'checkpointer') return 'checkpoint';
  return agent;
}
function formatNum(n) {
  if (n < 1000) return `${Math.round(n)}`;
  return `${(n / 1000).toFixed(1)}k`;
}
var AGG_OPS = ['sum', 'avg', 'min', 'max', 'count'];
function parseQuery(query) {
  let s = query.trim();
  let aggregation = undefined;
  let groupBy = [];
  for (const op of AGG_OPS) {
    if (s.startsWith(op)) {
      aggregation = op;
      s = s.slice(op.length).trim();
      break;
    }
  }
  if (aggregation) {
    const byMatch = s.match(/^by\s*\(\s*([^)]+)\s*\)\s*(.*)/);
    if (byMatch) {
      groupBy = byMatch[1]
        .split(',')
        .map(l => l.trim())
        .filter(Boolean);
      s = byMatch[2].trim();
    }
  }
  const matchers = [];
  const filterMatch = s.match(/^\{(.*)\}\s*$/);
  if (filterMatch) {
    const inner = filterMatch[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\w+)\s*(=~|=)\s*(.+)$/);
      if (m) {
        let value = m[3].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        const hasGlob = value.includes('*') || value.includes('?');
        const matcher = { label: m[1], op: m[2], value };
        if (m[2] === '=~' || hasGlob) {
          const regexStr = value
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          try {
            matcher.regex = new RegExp(`^${regexStr}$`, 'i');
          } catch {}
        }
        matchers.push(matcher);
      }
    }
  }
  return { aggregation, groupBy, matchers };
}
function getLabel(sample, label) {
  switch (label) {
    case 'agent':
      return sample.agent;
    case 'binary':
      return sample.binary;
    case 'phase':
      return derivePhase(sample.agent);
    case 'pidx':
      return sample.phaseIdx !== undefined ? String(sample.phaseIdx) : '';
    case 'verdict':
      return sample.verdict ?? '';
    case 'loop':
      return String(sample.loop);
    case 'propagated':
      return sample.propagated ? 'true' : 'false';
    case 'harness':
      return sample.harness ?? 'claude';
    default:
      return '';
  }
}
function matchSample(sample, matchers) {
  for (const m of matchers) {
    const val = getLabel(sample, m.label);
    if (m.regex) {
      if (!m.regex.test(val)) return false;
    } else if (val !== m.value) {
      return false;
    }
  }
  return true;
}
function aggregate(samples, aggregation, groupBy) {
  const groups = new Map();
  for (const s of samples) {
    const key = groupBy.map(l => `${l}=${getLabel(s, l)}`).join('\x00');
    const labels = {};
    for (const l of groupBy) labels[l] = getLabel(s, l);
    let group = groups.get(key);
    if (!group) {
      group = { samples: [], labels };
      groups.set(key, group);
    }
    group.samples.push(s);
  }
  const results = [];
  for (const [, group] of groups) {
    const n = group.samples.length;
    if (aggregation === 'count') {
      results.push({ labels: group.labels, count: n, durationMs: 0, inputTokens: 0, outputTokens: 0 });
      continue;
    }
    const dur = compute(
      n,
      group.samples.map(s => s.durationMs),
      aggregation,
    );
    const inTok = compute(
      n,
      group.samples.map(s => s.inputTokens),
      aggregation,
    );
    const outTok = compute(
      n,
      group.samples.map(s => s.outputTokens),
      aggregation,
    );
    results.push({ labels: group.labels, count: n, durationMs: dur, inputTokens: inTok, outputTokens: outTok });
  }
  results.sort((a, b) => {
    for (const l of groupBy) {
      const cmp = (a.labels[l] ?? '').localeCompare(b.labels[l] ?? '');
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  return results;
}
function compute(n, values, op) {
  if (n === 0) return 0;
  switch (op) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / n;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return 0;
  }
}
function padLeft(s, len) {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}
function padRight(s, len) {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}
async function handler7(query, opts, deps) {
  try {
    const { indexDb, state } = deps;
    let runId = opts.run;
    if (!runId && !query) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(import_picocolors8.default.yellow('No active run for this workspace.'));
        console.log(import_picocolors8.default.dim('Usage: kloop metrics [query] [--run <id>]'));
        console.log(import_picocolors8.default.dim('  kloop metrics                 # raw table'));
        console.log(import_picocolors8.default.dim('  kloop metrics "sum by (binary)"'));
        console.log(import_picocolors8.default.dim('  kloop metrics "avg by (phase) {agent=implementer}"'));
        return;
      }
      runId = row.id;
    } else if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (row) runId = row.id;
    }
    if (!runId) {
      console.log(
        import_picocolors8.default.yellow('No run found. Use --run <id> or run from a workspace with an active run.'),
      );
      return;
    }
    const samples = await loadSamples(runId, state);
    if (samples.length === 0) {
      console.log(import_picocolors8.default.yellow('No metrics found for this run.'));
      return;
    }
    if (!query) {
      return showRawTable(runId, samples, opts);
    }
    const parsed = parseQuery(query);
    const filtered = parsed.matchers.length > 0 ? samples.filter(s => matchSample(s, parsed.matchers)) : samples;
    if (filtered.length === 0) {
      console.log(import_picocolors8.default.yellow('No samples match query.'));
      return;
    }
    if (!parsed.aggregation) {
      return showRawTable(runId, filtered, opts);
    }
    const results = aggregate(filtered, parsed.aggregation, parsed.groupBy);
    if (opts.json) {
      console.log(
        JSON.stringify({ runId, query, aggregation: parsed.aggregation, groupBy: parsed.groupBy, results }, null, 2),
      );
      return;
    }
    console.log(
      import_picocolors8.default.bold(`Run: ${runId}  ${import_picocolors8.default.dim(`${filtered.length} samples`)}`),
    );
    if (parsed.matchers.length > 0) {
      const matcherStrs = parsed.matchers.map(m => `${m.label}${m.op}${m.value}`).join(', ');
      console.log(import_picocolors8.default.dim(`Filter: {${matcherStrs}}`));
    }
    console.log(
      import_picocolors8.default.dim(
        `Aggregation: ${parsed.aggregation}${parsed.groupBy.length > 0 ? ` by (${parsed.groupBy.join(', ')})` : ''}`,
      ),
    );
    console.log('');
    if (parsed.aggregation === 'count') {
      const labelW =
        parsed.groupBy.length > 0
          ? Math.max(
              8,
              ...parsed.groupBy.map(l => l.length),
              ...results.map(r => parsed.groupBy.map(l => r.labels[l] ?? '').join(', ').length),
            )
          : 12;
      const w = { label: labelW + 2, count: 8 };
      console.log(`${padRight('GROUP', w.label)}  ${padLeft('COUNT', w.count)}`);
      console.log(import_picocolors8.default.dim(`${'\u2500'.repeat(w.label)}  ${'\u2500'.repeat(w.count)}`));
      for (const r of results) {
        const labelStr = parsed.groupBy.map(l => r.labels[l] ?? '-').join(', ');
        console.log(`${padRight(labelStr, w.label)}  ${padLeft(String(r.count), w.count)}`);
      }
    } else {
      const labelW =
        parsed.groupBy.length > 0
          ? Math.max(
              8,
              ...parsed.groupBy.map(l => l.length),
              ...results.map(r => parsed.groupBy.map(l => r.labels[l] ?? '').join(', ').length),
            )
          : 12;
      const w = { label: labelW + 2, count: 6, dur: 10, inTok: 10, outTok: 10, total: 10 };
      console.log(
        `${padRight('GROUP', w.label)}  ${padLeft('N', w.count)}  ${padLeft('DURATION', w.dur)}  ${padLeft('IN', w.inTok)}  ${padLeft('OUT', w.outTok)}  ${padLeft('TOTAL', w.total)}`,
      );
      console.log(
        import_picocolors8.default.dim(
          `${'\u2500'.repeat(w.label)}  ${'\u2500'.repeat(w.count)}  ${'\u2500'.repeat(w.dur)}  ${'\u2500'.repeat(w.inTok)}  ${'\u2500'.repeat(w.outTok)}  ${'\u2500'.repeat(w.total)}`,
        ),
      );
      for (const r of results) {
        const labelStr = parsed.groupBy.map(l => r.labels[l] ?? '-').join(', ');
        console.log(
          `${padRight(labelStr, w.label)}  ${padLeft(String(r.count), w.count)}  ${padLeft(formatDuration5(r.durationMs), w.dur)}  ${padLeft(formatNum(r.inputTokens), w.inTok)}  ${padLeft(formatNum(r.outputTokens), w.outTok)}  ${padLeft(formatNum(r.inputTokens + r.outputTokens), w.total)}`,
        );
      }
    }
    console.log('');
    if (parsed.aggregation !== 'count') {
      const totalDur = results.reduce((s, r) => s + r.durationMs, 0);
      const totalIn = results.reduce((s, r) => s + r.inputTokens, 0);
      const totalOut = results.reduce((s, r) => s + r.outputTokens, 0);
      console.log(
        import_picocolors8.default.dim(
          `Total: ${formatDuration5(totalDur)}  ${formatNum(totalIn)} in  ${formatNum(totalOut)} out  ${formatNum(totalIn + totalOut)} total`,
        ),
      );
    }
  } catch (err) {
    console.error(import_picocolors8.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
function showRawTable(runId, samples, opts) {
  const totalDurationMs = samples.reduce((sum, s) => sum + s.durationMs, 0);
  const totalInputTokens = samples.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutputTokens = samples.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  if (opts.json) {
    console.log(
      JSON.stringify({ runId, totalDurationMs, totalInputTokens, totalOutputTokens, totalTokens, samples }, null, 2),
    );
    return;
  }
  console.log(import_picocolors8.default.bold(`Run: ${runId}`));
  console.log(
    `Total: ${formatDuration5(totalDurationMs)} | ${formatNum(totalTokens)} tokens (${formatNum(totalInputTokens)} in / ${formatNum(totalOutputTokens)} out)`,
  );
  console.log('');
  const w = {
    loop: 5,
    agent: 14,
    binary: 22,
    phase: 11,
    verdict: 10,
    comp: 6,
    duration: 10,
    input: 13,
    output: 13,
    total: 13,
    error: 12,
  };
  const header =
    padLeft('loop', w.loop) +
    padRight('agent', w.agent) +
    padRight('binary', w.binary) +
    padLeft('phase', w.phase) +
    padLeft('verdict', w.verdict) +
    padLeft('comp', w.comp) +
    padLeft('dur_s', w.duration) +
    padLeft('in_tok', w.input) +
    padLeft('out_tok', w.output) +
    padLeft('total', w.total) +
    padLeft('error', w.error);
  const sep = '\u2500'.repeat(Object.values(w).reduce((a, b) => a + b, 0));
  console.log(header);
  console.log(import_picocolors8.default.dim(sep));
  for (const s of samples) {
    const total = s.inputTokens + s.outputTokens;
    const isImpl = s.agent === 'implementer';
    const agentStr = isImpl
      ? import_picocolors8.default.cyan(padRight(s.agent, w.agent))
      : import_picocolors8.default.green(padRight(s.agent, w.agent));
    const binaryStr = padRight(shortBinary3(s.binary, s.harness), w.binary);
    const verdictStr = s.verdict
      ? s.verdict === 'approved'
        ? import_picocolors8.default.green(padLeft(s.verdict, w.verdict))
        : import_picocolors8.default.red(padLeft(s.verdict, w.verdict))
      : padLeft('-', w.verdict);
    const compStr =
      s.completionEstimate !== undefined ? padLeft(`${s.completionEstimate}%`, w.comp) : padLeft('-', w.comp);
    const errorStr = s.error ? import_picocolors8.default.yellow(padLeft(s.error, w.error)) : padLeft('-', w.error);
    const phaseStr = padLeft(derivePhase(s.agent), w.phase);
    console.log(
      padLeft(String(s.loop), w.loop) +
        agentStr +
        binaryStr +
        phaseStr +
        verdictStr +
        compStr +
        padLeft((s.durationMs / 1000).toFixed(1), w.duration) +
        padLeft(formatNum(s.inputTokens), w.input) +
        padLeft(formatNum(s.outputTokens), w.output) +
        padLeft(formatNum(total), w.total) +
        errorStr,
    );
  }
  console.log(import_picocolors8.default.dim(sep));
}
async function loadSamples(runId, state) {
  const runDir = paths.runPath(runId);
  const loopDirs = [];
  try {
    const entries = await state.fs.readdir(runDir);
    for (const entry of entries) {
      const match2 = entry.match(/^loop-(\d+)$/);
      if (match2) loopDirs.push(parseInt(match2[1], 10));
    }
  } catch {
    return [];
  }
  const allSamples = [];
  for (const loopNum of loopDirs.sort((a, b) => a - b)) {
    const metricsPath = paths.loopMetrics(runId, loopNum);
    if (await state.fs.exists(metricsPath)) {
      const content = await state.fs.readFile(metricsPath);
      for (const line of content.split(`
`)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          allSamples.push({
            loop: loopNum,
            agent: parsed.agent ?? '?',
            binary: parsed.binary ?? '',
            harness: parsed.harness,
            phaseIdx: parsed.phaseIdx,
            verdict: parsed.verdict,
            completionEstimate: parsed.completionEstimate,
            inputTokens: parsed.inputTokens ?? 0,
            outputTokens: parsed.outputTokens ?? 0,
            durationMs: parsed.durationMs ?? 0,
            error: parsed.error,
            propagated: parsed.propagated ?? false,
          });
        } catch {}
      }
    }
  }
  return allSamples;
}

// node_modules/@clack/core/dist/index.mjs
var import_sisteransi = __toESM(require_src(), 1);
import { stdin as j, stdout as M } from 'process';
import O from 'readline';
import { Writable as X } from 'stream';
function DD({ onlyFirst: e = false } = {}) {
  const t = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|');
  return new RegExp(t, e ? undefined : 'g');
}
var uD = DD();
function P(e) {
  if (typeof e != 'string') throw new TypeError(`Expected a \`string\`, got \`${typeof e}\``);
  return e.replace(uD, '');
}
function L(e) {
  return e && e.__esModule && Object.prototype.hasOwnProperty.call(e, 'default') ? e.default : e;
}
var W = { exports: {} };
(function (e) {
  var u = {};
  ((e.exports = u),
    (u.eastAsianWidth = function (F) {
      var s = F.charCodeAt(0),
        i = F.length == 2 ? F.charCodeAt(1) : 0,
        D = s;
      return (
        55296 <= s &&
          s <= 56319 &&
          56320 <= i &&
          i <= 57343 &&
          ((s &= 1023), (i &= 1023), (D = (s << 10) | i), (D += 65536)),
        D == 12288 || (65281 <= D && D <= 65376) || (65504 <= D && D <= 65510)
          ? 'F'
          : D == 8361 ||
              (65377 <= D && D <= 65470) ||
              (65474 <= D && D <= 65479) ||
              (65482 <= D && D <= 65487) ||
              (65490 <= D && D <= 65495) ||
              (65498 <= D && D <= 65500) ||
              (65512 <= D && D <= 65518)
            ? 'H'
            : (4352 <= D && D <= 4447) ||
                (4515 <= D && D <= 4519) ||
                (4602 <= D && D <= 4607) ||
                (9001 <= D && D <= 9002) ||
                (11904 <= D && D <= 11929) ||
                (11931 <= D && D <= 12019) ||
                (12032 <= D && D <= 12245) ||
                (12272 <= D && D <= 12283) ||
                (12289 <= D && D <= 12350) ||
                (12353 <= D && D <= 12438) ||
                (12441 <= D && D <= 12543) ||
                (12549 <= D && D <= 12589) ||
                (12593 <= D && D <= 12686) ||
                (12688 <= D && D <= 12730) ||
                (12736 <= D && D <= 12771) ||
                (12784 <= D && D <= 12830) ||
                (12832 <= D && D <= 12871) ||
                (12880 <= D && D <= 13054) ||
                (13056 <= D && D <= 19903) ||
                (19968 <= D && D <= 42124) ||
                (42128 <= D && D <= 42182) ||
                (43360 <= D && D <= 43388) ||
                (44032 <= D && D <= 55203) ||
                (55216 <= D && D <= 55238) ||
                (55243 <= D && D <= 55291) ||
                (63744 <= D && D <= 64255) ||
                (65040 <= D && D <= 65049) ||
                (65072 <= D && D <= 65106) ||
                (65108 <= D && D <= 65126) ||
                (65128 <= D && D <= 65131) ||
                (110592 <= D && D <= 110593) ||
                (127488 <= D && D <= 127490) ||
                (127504 <= D && D <= 127546) ||
                (127552 <= D && D <= 127560) ||
                (127568 <= D && D <= 127569) ||
                (131072 <= D && D <= 194367) ||
                (177984 <= D && D <= 196605) ||
                (196608 <= D && D <= 262141)
              ? 'W'
              : (32 <= D && D <= 126) ||
                  (162 <= D && D <= 163) ||
                  (165 <= D && D <= 166) ||
                  D == 172 ||
                  D == 175 ||
                  (10214 <= D && D <= 10221) ||
                  (10629 <= D && D <= 10630)
                ? 'Na'
                : D == 161 ||
                    D == 164 ||
                    (167 <= D && D <= 168) ||
                    D == 170 ||
                    (173 <= D && D <= 174) ||
                    (176 <= D && D <= 180) ||
                    (182 <= D && D <= 186) ||
                    (188 <= D && D <= 191) ||
                    D == 198 ||
                    D == 208 ||
                    (215 <= D && D <= 216) ||
                    (222 <= D && D <= 225) ||
                    D == 230 ||
                    (232 <= D && D <= 234) ||
                    (236 <= D && D <= 237) ||
                    D == 240 ||
                    (242 <= D && D <= 243) ||
                    (247 <= D && D <= 250) ||
                    D == 252 ||
                    D == 254 ||
                    D == 257 ||
                    D == 273 ||
                    D == 275 ||
                    D == 283 ||
                    (294 <= D && D <= 295) ||
                    D == 299 ||
                    (305 <= D && D <= 307) ||
                    D == 312 ||
                    (319 <= D && D <= 322) ||
                    D == 324 ||
                    (328 <= D && D <= 331) ||
                    D == 333 ||
                    (338 <= D && D <= 339) ||
                    (358 <= D && D <= 359) ||
                    D == 363 ||
                    D == 462 ||
                    D == 464 ||
                    D == 466 ||
                    D == 468 ||
                    D == 470 ||
                    D == 472 ||
                    D == 474 ||
                    D == 476 ||
                    D == 593 ||
                    D == 609 ||
                    D == 708 ||
                    D == 711 ||
                    (713 <= D && D <= 715) ||
                    D == 717 ||
                    D == 720 ||
                    (728 <= D && D <= 731) ||
                    D == 733 ||
                    D == 735 ||
                    (768 <= D && D <= 879) ||
                    (913 <= D && D <= 929) ||
                    (931 <= D && D <= 937) ||
                    (945 <= D && D <= 961) ||
                    (963 <= D && D <= 969) ||
                    D == 1025 ||
                    (1040 <= D && D <= 1103) ||
                    D == 1105 ||
                    D == 8208 ||
                    (8211 <= D && D <= 8214) ||
                    (8216 <= D && D <= 8217) ||
                    (8220 <= D && D <= 8221) ||
                    (8224 <= D && D <= 8226) ||
                    (8228 <= D && D <= 8231) ||
                    D == 8240 ||
                    (8242 <= D && D <= 8243) ||
                    D == 8245 ||
                    D == 8251 ||
                    D == 8254 ||
                    D == 8308 ||
                    D == 8319 ||
                    (8321 <= D && D <= 8324) ||
                    D == 8364 ||
                    D == 8451 ||
                    D == 8453 ||
                    D == 8457 ||
                    D == 8467 ||
                    D == 8470 ||
                    (8481 <= D && D <= 8482) ||
                    D == 8486 ||
                    D == 8491 ||
                    (8531 <= D && D <= 8532) ||
                    (8539 <= D && D <= 8542) ||
                    (8544 <= D && D <= 8555) ||
                    (8560 <= D && D <= 8569) ||
                    D == 8585 ||
                    (8592 <= D && D <= 8601) ||
                    (8632 <= D && D <= 8633) ||
                    D == 8658 ||
                    D == 8660 ||
                    D == 8679 ||
                    D == 8704 ||
                    (8706 <= D && D <= 8707) ||
                    (8711 <= D && D <= 8712) ||
                    D == 8715 ||
                    D == 8719 ||
                    D == 8721 ||
                    D == 8725 ||
                    D == 8730 ||
                    (8733 <= D && D <= 8736) ||
                    D == 8739 ||
                    D == 8741 ||
                    (8743 <= D && D <= 8748) ||
                    D == 8750 ||
                    (8756 <= D && D <= 8759) ||
                    (8764 <= D && D <= 8765) ||
                    D == 8776 ||
                    D == 8780 ||
                    D == 8786 ||
                    (8800 <= D && D <= 8801) ||
                    (8804 <= D && D <= 8807) ||
                    (8810 <= D && D <= 8811) ||
                    (8814 <= D && D <= 8815) ||
                    (8834 <= D && D <= 8835) ||
                    (8838 <= D && D <= 8839) ||
                    D == 8853 ||
                    D == 8857 ||
                    D == 8869 ||
                    D == 8895 ||
                    D == 8978 ||
                    (9312 <= D && D <= 9449) ||
                    (9451 <= D && D <= 9547) ||
                    (9552 <= D && D <= 9587) ||
                    (9600 <= D && D <= 9615) ||
                    (9618 <= D && D <= 9621) ||
                    (9632 <= D && D <= 9633) ||
                    (9635 <= D && D <= 9641) ||
                    (9650 <= D && D <= 9651) ||
                    (9654 <= D && D <= 9655) ||
                    (9660 <= D && D <= 9661) ||
                    (9664 <= D && D <= 9665) ||
                    (9670 <= D && D <= 9672) ||
                    D == 9675 ||
                    (9678 <= D && D <= 9681) ||
                    (9698 <= D && D <= 9701) ||
                    D == 9711 ||
                    (9733 <= D && D <= 9734) ||
                    D == 9737 ||
                    (9742 <= D && D <= 9743) ||
                    (9748 <= D && D <= 9749) ||
                    D == 9756 ||
                    D == 9758 ||
                    D == 9792 ||
                    D == 9794 ||
                    (9824 <= D && D <= 9825) ||
                    (9827 <= D && D <= 9829) ||
                    (9831 <= D && D <= 9834) ||
                    (9836 <= D && D <= 9837) ||
                    D == 9839 ||
                    (9886 <= D && D <= 9887) ||
                    (9918 <= D && D <= 9919) ||
                    (9924 <= D && D <= 9933) ||
                    (9935 <= D && D <= 9953) ||
                    D == 9955 ||
                    (9960 <= D && D <= 9983) ||
                    D == 10045 ||
                    D == 10071 ||
                    (10102 <= D && D <= 10111) ||
                    (11093 <= D && D <= 11097) ||
                    (12872 <= D && D <= 12879) ||
                    (57344 <= D && D <= 63743) ||
                    (65024 <= D && D <= 65039) ||
                    D == 65533 ||
                    (127232 <= D && D <= 127242) ||
                    (127248 <= D && D <= 127277) ||
                    (127280 <= D && D <= 127337) ||
                    (127344 <= D && D <= 127386) ||
                    (917760 <= D && D <= 917999) ||
                    (983040 <= D && D <= 1048573) ||
                    (1048576 <= D && D <= 1114109)
                  ? 'A'
                  : 'N'
      );
    }),
    (u.characterLength = function (F) {
      var s = this.eastAsianWidth(F);
      return s == 'F' || s == 'W' || s == 'A' ? 2 : 1;
    }));
  function t(F) {
    return F.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF]/g) || [];
  }
  ((u.length = function (F) {
    for (var s = t(F), i = 0, D = 0; D < s.length; D++) i = i + this.characterLength(s[D]);
    return i;
  }),
    (u.slice = function (F, s, i) {
      ((textLen = u.length(F)), (s = s || 0), (i = i || 1), s < 0 && (s = textLen + s), i < 0 && (i = textLen + i));
      for (var D = '', C = 0, n = t(F), E = 0; E < n.length; E++) {
        var a = n[E],
          o = u.length(a);
        if (C >= s - (o == 2 ? 1 : 0))
          if (C + o <= i) D += a;
          else break;
        C += o;
      }
      return D;
    }));
})(W);
var tD = W.exports;
var eD = L(tD);
var FD = function () {
  return /\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67)\uDB40\uDC7F|(?:\uD83E\uDDD1\uD83C\uDFFF\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFE])|(?:\uD83E\uDDD1\uD83C\uDFFE\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFD\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFC\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFB\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFB\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFC-\uDFFF])|\uD83D\uDC68(?:\uD83C\uDFFB(?:\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF]))|\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFC-\uDFFF])|[\u2695\u2696\u2708]\uFE0F|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))?|(?:\uD83C[\uDFFC-\uDFFF])\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFF]))|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83D\uDC68|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFE])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])\uFE0F|\u200D(?:(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D[\uDC66\uDC67])|\uD83D[\uDC66\uDC67])|\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC)?|(?:\uD83D\uDC69(?:\uD83C\uDFFB\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|(?:\uD83C[\uDFFC-\uDFFF])\u200D\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69]))|\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1)(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC69(?:\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83E\uDDD1(?:\u200D(?:\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF7C\uDF84\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83D\uDC69\u200D\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D[\uDC66\uDC67])|\uD83D\uDC69\u200D\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D\uDC41\uFE0F\u200D\uD83D\uDDE8|\uD83E\uDDD1(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|\uD83D\uDC69(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|\uD83D\uDE36\u200D\uD83C\uDF2B|\uD83C\uDFF3\uFE0F\u200D\u26A7|\uD83D\uDC3B\u200D\u2744|(?:(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF])\u200D[\u2640\u2642]|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|\uD83C\uDFF4\u200D\u2620|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])\u200D[\u2640\u2642]|[\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u2328\u23CF\u23ED-\u23EF\u23F1\u23F2\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB\u25FC\u2600-\u2604\u260E\u2611\u2618\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u2692\u2694-\u2697\u2699\u269B\u269C\u26A0\u26A7\u26B0\u26B1\u26C8\u26CF\u26D1\u26D3\u26E9\u26F0\u26F1\u26F4\u26F7\u26F8\u2702\u2708\u2709\u270F\u2712\u2714\u2716\u271D\u2721\u2733\u2734\u2744\u2747\u2763\u27A1\u2934\u2935\u2B05-\u2B07\u3030\u303D\u3297\u3299]|\uD83C[\uDD70\uDD71\uDD7E\uDD7F\uDE02\uDE37\uDF21\uDF24-\uDF2C\uDF36\uDF7D\uDF96\uDF97\uDF99-\uDF9B\uDF9E\uDF9F\uDFCD\uDFCE\uDFD4-\uDFDF\uDFF5\uDFF7]|\uD83D[\uDC3F\uDCFD\uDD49\uDD4A\uDD6F\uDD70\uDD73\uDD76-\uDD79\uDD87\uDD8A-\uDD8D\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA\uDECB\uDECD-\uDECF\uDEE0-\uDEE5\uDEE9\uDEF0\uDEF3])\uFE0F|\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08|\uD83D\uDC69\u200D\uD83D\uDC67|\uD83D\uDC69\u200D\uD83D\uDC66|\uD83D\uDE35\u200D\uD83D\uDCAB|\uD83D\uDE2E\u200D\uD83D\uDCA8|\uD83D\uDC15\u200D\uD83E\uDDBA|\uD83E\uDDD1(?:\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC|\uD83C\uDFFB)?|\uD83D\uDC69(?:\uD83C\uDFFF|\uD83C\uDFFE|\uD83C\uDFFD|\uD83C\uDFFC|\uD83C\uDFFB)?|\uD83C\uDDFD\uD83C\uDDF0|\uD83C\uDDF6\uD83C\uDDE6|\uD83C\uDDF4\uD83C\uDDF2|\uD83D\uDC08\u200D\u2B1B|\u2764\uFE0F\u200D(?:\uD83D\uDD25|\uD83E\uDE79)|\uD83D\uDC41\uFE0F|\uD83C\uDFF3\uFE0F|\uD83C\uDDFF(?:\uD83C[\uDDE6\uDDF2\uDDFC])|\uD83C\uDDFE(?:\uD83C[\uDDEA\uDDF9])|\uD83C\uDDFC(?:\uD83C[\uDDEB\uDDF8])|\uD83C\uDDFB(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA])|\uD83C\uDDFA(?:\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF])|\uD83C\uDDF9(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF])|\uD83C\uDDF8(?:\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF])|\uD83C\uDDF7(?:\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC])|\uD83C\uDDF5(?:\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE])|\uD83C\uDDF3(?:\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF])|\uD83C\uDDF2(?:\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF])|\uD83C\uDDF1(?:\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE])|\uD83C\uDDF0(?:\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF])|\uD83C\uDDEF(?:\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5])|\uD83C\uDDEE(?:\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9])|\uD83C\uDDED(?:\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA])|\uD83C\uDDEC(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE])|\uD83C\uDDEB(?:\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7])|\uD83C\uDDEA(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA])|\uD83C\uDDE9(?:\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF])|\uD83C\uDDE8(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF])|\uD83C\uDDE7(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF])|\uD83C\uDDE6(?:\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF])|[#\*0-9]\uFE0F\u20E3|\u2764\uFE0F|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])|\uD83C\uDFF4|(?:[\u270A\u270B]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5])(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u261D\u270C\u270D]|\uD83D[\uDD74\uDD90])(?:\uFE0F|\uD83C[\uDFFB-\uDFFF])|[\u270A\u270B]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC08\uDC15\uDC3B\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDC8F\uDC91\uDCAA\uDD7A\uDD95\uDD96\uDE2E\uDE35\uDE36\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD34\uDD36\uDD77\uDDB5\uDDB6\uDDBB\uDDD2\uDDD3\uDDD5]|\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC70\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD35\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD4\uDDD6-\uDDDD]|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF]|[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF84\uDF86-\uDF93\uDFA0-\uDFC1\uDFC5\uDFC6\uDFC8\uDFC9\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC07\uDC09-\uDC14\uDC16-\uDC3A\uDC3C-\uDC3E\uDC40\uDC44\uDC45\uDC51-\uDC65\uDC6A\uDC79-\uDC7B\uDC7D-\uDC80\uDC84\uDC88-\uDC8E\uDC90\uDC92-\uDCA9\uDCAB-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDDA4\uDDFB-\uDE2D\uDE2F-\uDE34\uDE37-\uDE44\uDE48-\uDE4A\uDE80-\uDEA2\uDEA4-\uDEB3\uDEB7-\uDEBF\uDEC1-\uDEC5\uDED0-\uDED2\uDED5-\uDED7\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0D\uDD0E\uDD10-\uDD17\uDD1D\uDD20-\uDD25\uDD27-\uDD2F\uDD3A\uDD3F-\uDD45\uDD47-\uDD76\uDD78\uDD7A-\uDDB4\uDDB7\uDDBA\uDDBC-\uDDCB\uDDD0\uDDE0-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6]|(?:[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDED5-\uDED7\uDEEB\uDEEC\uDEF4-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDD78\uDD7A-\uDDCB\uDDCD-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6])|(?:[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26A7\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]|\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5-\uDED7\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEFC\uDFE0-\uDFEB]|\uD83E[\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDD78\uDD7A-\uDDCB\uDDCD-\uDDFF\uDE70-\uDE74\uDE78-\uDE7A\uDE80-\uDE86\uDE90-\uDEA8\uDEB0-\uDEB6\uDEC0-\uDEC2\uDED0-\uDED6])\uFE0F|(?:[\u261D\u26F9\u270A-\u270D]|\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDC8F\uDC91\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD0C\uDD0F\uDD18-\uDD1F\uDD26\uDD30-\uDD39\uDD3C-\uDD3E\uDD77\uDDB5\uDDB6\uDDB8\uDDB9\uDDBB\uDDCD-\uDDCF\uDDD1-\uDDDD])/g;
};
var sD = L(FD);
function p(e, u = {}) {
  if (typeof e != 'string' || e.length === 0 || ((u = { ambiguousIsNarrow: true, ...u }), (e = P(e)), e.length === 0))
    return 0;
  e = e.replace(sD(), '  ');
  const t = u.ambiguousIsNarrow ? 1 : 2;
  let F = 0;
  for (const s of e) {
    const i = s.codePointAt(0);
    if (i <= 31 || (i >= 127 && i <= 159) || (i >= 768 && i <= 879)) continue;
    switch (eD.eastAsianWidth(s)) {
      case 'F':
      case 'W':
        F += 2;
        break;
      case 'A':
        F += t;
        break;
      default:
        F += 1;
    }
  }
  return F;
}
var w = 10;
var N =
  (e = 0) =>
  u =>
    `\x1B[${u + e}m`;
var I =
  (e = 0) =>
  u =>
    `\x1B[${38 + e};5;${u}m`;
var R =
  (e = 0) =>
  (u, t, F) =>
    `\x1B[${38 + e};2;${u};${t};${F}m`;
var r = {
  modifier: {
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    overline: [53, 55],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
  },
  color: {
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    blackBright: [90, 39],
    gray: [90, 39],
    grey: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
  },
  bgColor: {
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    bgBlackBright: [100, 49],
    bgGray: [100, 49],
    bgGrey: [100, 49],
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49],
  },
};
Object.keys(r.modifier);
var iD = Object.keys(r.color);
var CD = Object.keys(r.bgColor);
[...iD, ...CD];
function rD() {
  const e = new Map();
  for (const [u, t] of Object.entries(r)) {
    for (const [F, s] of Object.entries(t))
      ((r[F] = { open: `\x1B[${s[0]}m`, close: `\x1B[${s[1]}m` }), (t[F] = r[F]), e.set(s[0], s[1]));
    Object.defineProperty(r, u, { value: t, enumerable: false });
  }
  return (
    Object.defineProperty(r, 'codes', { value: e, enumerable: false }),
    (r.color.close = '\x1B[39m'),
    (r.bgColor.close = '\x1B[49m'),
    (r.color.ansi = N()),
    (r.color.ansi256 = I()),
    (r.color.ansi16m = R()),
    (r.bgColor.ansi = N(w)),
    (r.bgColor.ansi256 = I(w)),
    (r.bgColor.ansi16m = R(w)),
    Object.defineProperties(r, {
      rgbToAnsi256: {
        value: (u, t, F) =>
          u === t && t === F
            ? u < 8
              ? 16
              : u > 248
                ? 231
                : Math.round(((u - 8) / 247) * 24) + 232
            : 16 + 36 * Math.round((u / 255) * 5) + 6 * Math.round((t / 255) * 5) + Math.round((F / 255) * 5),
        enumerable: false,
      },
      hexToRgb: {
        value: u => {
          const t = /[a-f\d]{6}|[a-f\d]{3}/i.exec(u.toString(16));
          if (!t) return [0, 0, 0];
          let [F] = t;
          F.length === 3 && (F = [...F].map(i => i + i).join(''));
          const s = Number.parseInt(F, 16);
          return [(s >> 16) & 255, (s >> 8) & 255, s & 255];
        },
        enumerable: false,
      },
      hexToAnsi256: { value: u => r.rgbToAnsi256(...r.hexToRgb(u)), enumerable: false },
      ansi256ToAnsi: {
        value: u => {
          if (u < 8) return 30 + u;
          if (u < 16) return 90 + (u - 8);
          let t, F, s;
          if (u >= 232) ((t = ((u - 232) * 10 + 8) / 255), (F = t), (s = t));
          else {
            u -= 16;
            const C = u % 36;
            ((t = Math.floor(u / 36) / 5), (F = Math.floor(C / 6) / 5), (s = (C % 6) / 5));
          }
          const i = Math.max(t, F, s) * 2;
          if (i === 0) return 30;
          let D = 30 + ((Math.round(s) << 2) | (Math.round(F) << 1) | Math.round(t));
          return (i === 2 && (D += 60), D);
        },
        enumerable: false,
      },
      rgbToAnsi: { value: (u, t, F) => r.ansi256ToAnsi(r.rgbToAnsi256(u, t, F)), enumerable: false },
      hexToAnsi: { value: u => r.ansi256ToAnsi(r.hexToAnsi256(u)), enumerable: false },
    }),
    r
  );
}
var ED = rD();
var d = new Set(['\x1B', '\x9B']);
var oD = 39;
var y = '\x07';
var V = '[';
var nD = ']';
var G = 'm';
var _ = `${nD}8;;`;
var z = e => `${d.values().next().value}${V}${e}${G}`;
var K = e => `${d.values().next().value}${_}${e}${y}`;
var aD = e => e.split(' ').map(u => p(u));
var k = (e, u, t) => {
  const F = [...u];
  let s = false,
    i = false,
    D = p(P(e[e.length - 1]));
  for (const [C, n] of F.entries()) {
    const E = p(n);
    if (
      (D + E <= t ? (e[e.length - 1] += n) : (e.push(n), (D = 0)),
      d.has(n) &&
        ((s = true),
        (i = F.slice(C + 1)
          .join('')
          .startsWith(_))),
      s)
    ) {
      i ? n === y && ((s = false), (i = false)) : n === G && (s = false);
      continue;
    }
    ((D += E), D === t && C < F.length - 1 && (e.push(''), (D = 0)));
  }
  !D && e[e.length - 1].length > 0 && e.length > 1 && (e[e.length - 2] += e.pop());
};
var hD = e => {
  const u = e.split(' ');
  let t = u.length;
  for (; t > 0 && !(p(u[t - 1]) > 0); ) t--;
  return t === u.length ? e : u.slice(0, t).join(' ') + u.slice(t).join('');
};
var lD = (e, u, t = {}) => {
  if (t.trim !== false && e.trim() === '') return '';
  let F = '',
    s,
    i;
  const D = aD(e);
  let C = [''];
  for (const [E, a] of e.split(' ').entries()) {
    t.trim !== false && (C[C.length - 1] = C[C.length - 1].trimStart());
    let o = p(C[C.length - 1]);
    if (
      (E !== 0 &&
        (o >= u && (t.wordWrap === false || t.trim === false) && (C.push(''), (o = 0)),
        (o > 0 || t.trim === false) && ((C[C.length - 1] += ' '), o++)),
      t.hard && D[E] > u)
    ) {
      const c = u - o,
        f = 1 + Math.floor((D[E] - c - 1) / u);
      (Math.floor((D[E] - 1) / u) < f && C.push(''), k(C, a, u));
      continue;
    }
    if (o + D[E] > u && o > 0 && D[E] > 0) {
      if (t.wordWrap === false && o < u) {
        k(C, a, u);
        continue;
      }
      C.push('');
    }
    if (o + D[E] > u && t.wordWrap === false) {
      k(C, a, u);
      continue;
    }
    C[C.length - 1] += a;
  }
  t.trim !== false && (C = C.map(E => hD(E)));
  const n = [
    ...C.join(`
`),
  ];
  for (const [E, a] of n.entries()) {
    if (((F += a), d.has(a))) {
      const { groups: c } = new RegExp(`(?:\\${V}(?<code>\\d+)m|\\${_}(?<uri>.*)${y})`).exec(n.slice(E).join('')) || {
        groups: {},
      };
      if (c.code !== undefined) {
        const f = Number.parseFloat(c.code);
        s = f === oD ? undefined : f;
      } else c.uri !== undefined && (i = c.uri.length === 0 ? undefined : c.uri);
    }
    const o = ED.codes.get(Number(s));
    n[E + 1] ===
    `
`
      ? (i && (F += K('')), s && o && (F += z(o)))
      : a ===
          `
` && (s && o && (F += z(s)), i && (F += K(i)));
  }
  return F;
};
function Y(e, u, t) {
  return String(e)
    .normalize()
    .replace(
      /\r\n/g,
      `
`,
    )
    .split(
      `
`,
    )
    .map(F => lD(F, u, t)).join(`
`);
}
var xD = ['up', 'down', 'left', 'right', 'space', 'enter', 'cancel'];
var B = {
  actions: new Set(xD),
  aliases: new Map([
    ['k', 'up'],
    ['j', 'down'],
    ['h', 'left'],
    ['l', 'right'],
    ['\x03', 'cancel'],
    ['escape', 'cancel'],
  ]),
};
function $(e, u) {
  if (typeof e == 'string') return B.aliases.get(e) === u;
  for (const t of e) if (t !== undefined && $(t, u)) return true;
  return false;
}
function BD(e, u) {
  if (e === u) return;
  const t = e.split(`
`),
    F = u.split(`
`),
    s = [];
  for (let i = 0; i < Math.max(t.length, F.length); i++) t[i] !== F[i] && s.push(i);
  return s;
}
var AD = globalThis.process.platform.startsWith('win');
var S = Symbol('clack:cancel');
function pD(e) {
  return e === S;
}
function m(e, u) {
  const t = e;
  t.isTTY && t.setRawMode(u);
}
var gD = Object.defineProperty;
var vD = (e, u, t) =>
  u in e ? gD(e, u, { enumerable: true, configurable: true, writable: true, value: t }) : (e[u] = t);
var h = (e, u, t) => (vD(e, typeof u != 'symbol' ? u + '' : u, t), t);

class x {
  constructor(u, t = true) {
    (h(this, 'input'),
      h(this, 'output'),
      h(this, '_abortSignal'),
      h(this, 'rl'),
      h(this, 'opts'),
      h(this, '_render'),
      h(this, '_track', false),
      h(this, '_prevFrame', ''),
      h(this, '_subscribers', new Map()),
      h(this, '_cursor', 0),
      h(this, 'state', 'initial'),
      h(this, 'error', ''),
      h(this, 'value'));
    const { input: F = j, output: s = M, render: i, signal: D, ...C } = u;
    ((this.opts = C),
      (this.onKeypress = this.onKeypress.bind(this)),
      (this.close = this.close.bind(this)),
      (this.render = this.render.bind(this)),
      (this._render = i.bind(this)),
      (this._track = t),
      (this._abortSignal = D),
      (this.input = F),
      (this.output = s));
  }
  unsubscribe() {
    this._subscribers.clear();
  }
  setSubscriber(u, t) {
    const F = this._subscribers.get(u) ?? [];
    (F.push(t), this._subscribers.set(u, F));
  }
  on(u, t) {
    this.setSubscriber(u, { cb: t });
  }
  once(u, t) {
    this.setSubscriber(u, { cb: t, once: true });
  }
  emit(u, ...t) {
    const F = this._subscribers.get(u) ?? [],
      s = [];
    for (const i of F) (i.cb(...t), i.once && s.push(() => F.splice(F.indexOf(i), 1)));
    for (const i of s) i();
  }
  prompt() {
    return new Promise((u, t) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted) return ((this.state = 'cancel'), this.close(), u(S));
        this._abortSignal.addEventListener(
          'abort',
          () => {
            ((this.state = 'cancel'), this.close());
          },
          { once: true },
        );
      }
      const F = new X();
      ((F._write = (s, i, D) => {
        (this._track &&
          ((this.value = this.rl?.line.replace(/\t/g, '')),
          (this._cursor = this.rl?.cursor ?? 0),
          this.emit('value', this.value)),
          D());
      }),
        this.input.pipe(F),
        (this.rl = O.createInterface({
          input: this.input,
          output: F,
          tabSize: 2,
          prompt: '',
          escapeCodeTimeout: 50,
          terminal: true,
        })),
        O.emitKeypressEvents(this.input, this.rl),
        this.rl.prompt(),
        this.opts.initialValue !== undefined && this._track && this.rl.write(this.opts.initialValue),
        this.input.on('keypress', this.onKeypress),
        m(this.input, true),
        this.output.on('resize', this.render),
        this.render(),
        this.once('submit', () => {
          (this.output.write(import_sisteransi.cursor.show),
            this.output.off('resize', this.render),
            m(this.input, false),
            u(this.value));
        }),
        this.once('cancel', () => {
          (this.output.write(import_sisteransi.cursor.show),
            this.output.off('resize', this.render),
            m(this.input, false),
            u(S));
        }));
    });
  }
  onKeypress(u, t) {
    if (
      (this.state === 'error' && (this.state = 'active'),
      t?.name &&
        (!this._track && B.aliases.has(t.name) && this.emit('cursor', B.aliases.get(t.name)),
        B.actions.has(t.name) && this.emit('cursor', t.name)),
      u && (u.toLowerCase() === 'y' || u.toLowerCase() === 'n') && this.emit('confirm', u.toLowerCase() === 'y'),
      u === '\t' &&
        this.opts.placeholder &&
        (this.value || (this.rl?.write(this.opts.placeholder), this.emit('value', this.opts.placeholder))),
      u && this.emit('key', u.toLowerCase()),
      t?.name === 'return')
    ) {
      if (this.opts.validate) {
        const F = this.opts.validate(this.value);
        F && ((this.error = F instanceof Error ? F.message : F), (this.state = 'error'), this.rl?.write(this.value));
      }
      this.state !== 'error' && (this.state = 'submit');
    }
    ($([u, t?.name, t?.sequence], 'cancel') && (this.state = 'cancel'),
      (this.state === 'submit' || this.state === 'cancel') && this.emit('finalize'),
      this.render(),
      (this.state === 'submit' || this.state === 'cancel') && this.close());
  }
  close() {
    (this.input.unpipe(),
      this.input.removeListener('keypress', this.onKeypress),
      this.output.write(`
`),
      m(this.input, false),
      this.rl?.close(),
      (this.rl = undefined),
      this.emit(`${this.state}`, this.value),
      this.unsubscribe());
  }
  restoreCursor() {
    const u =
      Y(this._prevFrame, process.stdout.columns, { hard: true }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, u * -1));
  }
  render() {
    const u = Y(this._render(this) ?? '', process.stdout.columns, { hard: true });
    if (u !== this._prevFrame) {
      if (this.state === 'initial') this.output.write(import_sisteransi.cursor.hide);
      else {
        const t = BD(this._prevFrame, u);
        if ((this.restoreCursor(), t && t?.length === 1)) {
          const F = t[0];
          (this.output.write(import_sisteransi.cursor.move(0, F)), this.output.write(import_sisteransi.erase.lines(1)));
          const s = u.split(`
`);
          (this.output.write(s[F]),
            (this._prevFrame = u),
            this.output.write(import_sisteransi.cursor.move(0, s.length - F - 1)));
          return;
        }
        if (t && t?.length > 1) {
          const F = t[0];
          (this.output.write(import_sisteransi.cursor.move(0, F)), this.output.write(import_sisteransi.erase.down()));
          const s = u
            .split(
              `
`,
            )
            .slice(F);
          (this.output.write(
            s.join(`
`),
          ),
            (this._prevFrame = u));
          return;
        }
        this.output.write(import_sisteransi.erase.down());
      }
      (this.output.write(u), this.state === 'initial' && (this.state = 'active'), (this._prevFrame = u));
    }
  }
}
var A;
A = new WeakMap();
var OD = Object.defineProperty;
var PD = (e, u, t) =>
  u in e ? OD(e, u, { enumerable: true, configurable: true, writable: true, value: t }) : (e[u] = t);
var J = (e, u, t) => (PD(e, typeof u != 'symbol' ? u + '' : u, t), t);

class LD extends x {
  constructor(u) {
    (super(u, false),
      J(this, 'options'),
      J(this, 'cursor', 0),
      (this.options = u.options),
      (this.cursor = this.options.findIndex(({ value: t }) => t === u.initialValue)),
      this.cursor === -1 && (this.cursor = 0),
      this.changeValue(),
      this.on('cursor', t => {
        switch (t) {
          case 'left':
          case 'up':
            this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
            break;
          case 'down':
          case 'right':
            this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
            break;
        }
        this.changeValue();
      }));
  }
  get _value() {
    return this.options[this.cursor];
  }
  changeValue() {
    this.value = this._value.value;
  }
}

// node_modules/@clack/prompts/dist/index.mjs
var import_picocolors9 = __toESM(require_picocolors(), 1);
var import_sisteransi2 = __toESM(require_src(), 1);
import y2 from 'process';
function ce() {
  return y2.platform !== 'win32'
    ? y2.env.TERM !== 'linux'
    : !!y2.env.CI ||
        !!y2.env.WT_SESSION ||
        !!y2.env.TERMINUS_SUBLIME ||
        y2.env.ConEmuTask === '{cmd::Cmder}' ||
        y2.env.TERM_PROGRAM === 'Terminus-Sublime' ||
        y2.env.TERM_PROGRAM === 'vscode' ||
        y2.env.TERM === 'xterm-256color' ||
        y2.env.TERM === 'alacritty' ||
        y2.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm';
}
var V2 = ce();
var u = (t, n) => (V2 ? t : n);
var le = u('\u25C6', '*');
var L2 = u('\u25A0', 'x');
var W2 = u('\u25B2', 'x');
var C = u('\u25C7', 'o');
var ue = u('\u250C', 'T');
var o = u('\u2502', '|');
var d2 = u('\u2514', '\u2014');
var k2 = u('\u25CF', '>');
var P2 = u('\u25CB', ' ');
var A2 = u('\u25FB', '[\u2022]');
var T = u('\u25FC', '[+]');
var F = u('\u25FB', '[ ]');
var $e = u('\u25AA', '\u2022');
var _2 = u('\u2500', '-');
var me = u('\u256E', '+');
var de = u('\u251C', '+');
var pe = u('\u256F', '+');
var q = u('\u25CF', '\u2022');
var D = u('\u25C6', '*');
var U = u('\u25B2', '!');
var K2 = u('\u25A0', 'x');
var b2 = t => {
  switch (t) {
    case 'initial':
    case 'active':
      return import_picocolors9.default.cyan(le);
    case 'cancel':
      return import_picocolors9.default.red(L2);
    case 'error':
      return import_picocolors9.default.yellow(W2);
    case 'submit':
      return import_picocolors9.default.green(C);
  }
};
var G2 = t => {
  const { cursor: n, options: r2, style: i } = t,
    s = t.maxItems ?? Number.POSITIVE_INFINITY,
    c = Math.max(process.stdout.rows - 4, 0),
    a = Math.min(c, Math.max(s, 5));
  let l2 = 0;
  n >= l2 + a - 3 ? (l2 = Math.max(Math.min(n - a + 3, r2.length - a), 0)) : n < l2 + 2 && (l2 = Math.max(n - 2, 0));
  const $2 = a < r2.length && l2 > 0,
    g = a < r2.length && l2 + a < r2.length;
  return r2.slice(l2, l2 + a).map((p2, v, f) => {
    const j2 = v === 0 && $2,
      E = v === f.length - 1 && g;
    return j2 || E ? import_picocolors9.default.dim('...') : i(p2, v + l2 === n);
  });
};
var ve = t => {
  const n = (r2, i) => {
    const s = r2.label ?? String(r2.value);
    switch (i) {
      case 'selected':
        return `${import_picocolors9.default.dim(s)}`;
      case 'active':
        return `${import_picocolors9.default.green(k2)} ${s} ${r2.hint ? import_picocolors9.default.dim(`(${r2.hint})`) : ''}`;
      case 'cancelled':
        return `${import_picocolors9.default.strikethrough(import_picocolors9.default.dim(s))}`;
      default:
        return `${import_picocolors9.default.dim(P2)} ${import_picocolors9.default.dim(s)}`;
    }
  };
  return new LD({
    options: t.options,
    initialValue: t.initialValue,
    render() {
      const r2 = `${import_picocolors9.default.gray(o)}
${b2(this.state)}  ${t.message}
`;
      switch (this.state) {
        case 'submit':
          return `${r2}${import_picocolors9.default.gray(o)}  ${n(this.options[this.cursor], 'selected')}`;
        case 'cancel':
          return `${r2}${import_picocolors9.default.gray(o)}  ${n(this.options[this.cursor], 'cancelled')}
${import_picocolors9.default.gray(o)}`;
        default:
          return `${r2}${import_picocolors9.default.cyan(o)}  ${G2({
            cursor: this.cursor,
            options: this.options,
            maxItems: t.maxItems,
            style: (i, s) => n(i, s ? 'active' : 'inactive'),
          }).join(`
${import_picocolors9.default.cyan(o)}  `)}
${import_picocolors9.default.cyan(d2)}
`;
      }
    },
  }).prompt();
};
var xe = (t = '') => {
  process.stdout.write(`${import_picocolors9.default.gray(d2)}  ${import_picocolors9.default.red(t)}

`);
};
var Ie = (t = '') => {
  process.stdout.write(`${import_picocolors9.default.gray(ue)}  ${t}
`);
};
var Se = (t = '') => {
  process.stdout.write(`${import_picocolors9.default.gray(o)}
${import_picocolors9.default.gray(d2)}  ${t}

`);
};
var J2 = `${import_picocolors9.default.gray(o)}  `;

// src/cli/attach.ts
var import_picocolors10 = __toESM(require_picocolors(), 1);

// src/tmux/commands.ts
function generateSessionName(params) {
  const { runId, iteration, role, reviewerIndex } = params;
  if (role === 'rev' && reviewerIndex !== undefined) {
    return `kloop-${runId}-${iteration}-rev-${reviewerIndex}`;
  }
  return `kloop-${runId}-${iteration}-${role}`;
}
function parseSessionName(sessionName) {
  if (sessionName.startsWith('kloop-')) {
    return parseKloopSessionName(sessionName);
  }
  if (sessionName.startsWith('devloop-')) {
    return parseLegacySessionName(sessionName);
  }
  return null;
}
function parseKloopSessionName(sessionName) {
  const withoutPrefix = sessionName.slice('kloop-'.length);
  if (withoutPrefix.endsWith('-daemon')) {
    const runId2 = withoutPrefix.slice(0, -'-daemon'.length);
    return { dirHash: '', runId: runId2, iteration: 0, role: 'impl' };
  }
  const parts = withoutPrefix.split('-');
  if (parts.length < 3) {
    return null;
  }
  const runId = parts[0];
  const iteration = parseInt(parts[1], 10);
  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }
  const role = parts[2];
  if (role !== 'impl' && role !== 'rev') {
    return null;
  }
  const reviewerIndex = parts[3] !== undefined ? parseInt(parts[3], 10) : undefined;
  return {
    dirHash: '',
    runId,
    iteration,
    role,
    reviewerIndex,
  };
}
function parseLegacySessionName(sessionName) {
  const withoutPrefix = sessionName.slice('devloop-'.length);
  const parts = withoutPrefix.split('-');
  if (parts.length < 4) {
    return null;
  }
  const dirHash = parts[0];
  const runId = parts[1];
  const iteration = parseInt(parts[2], 10);
  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }
  const role = parts[3];
  if (role !== 'impl' && role !== 'rev') {
    return null;
  }
  const reviewerIndex = parts[4] !== undefined ? parseInt(parts[4], 10) : undefined;
  return {
    dirHash,
    runId,
    iteration,
    role,
    reviewerIndex,
  };
}
function buildNewSessionCommand(params) {
  const commandWithUnset = `unset CLAUDECODE && ${params.command}`;
  return [
    'tmux',
    'new-session',
    '-d',
    '-s',
    params.sessionName,
    '-c',
    params.cwd,
    '-e',
    'CLAUDECODE=',
    'env',
    '-u',
    'CLAUDECODE',
    'sh',
    '-c',
    commandWithUnset,
  ];
}
function buildHasSessionCommand(sessionName) {
  return ['tmux', 'has-session', '-t', sessionName];
}
function buildListSessionsCommand() {
  return ['tmux', 'ls', '-F', '#{session_name}'];
}
function buildKillSessionCommand(sessionName) {
  return ['tmux', 'kill-session', '-t', sessionName];
}
function buildTimeoutCommand(command, timeoutMins) {
  return `timeout ${timeoutMins}m ${command}`;
}

// src/cli/attach.ts
function formatSessionChoice(sessionName) {
  const parsed = parseSessionName(sessionName);
  if (!parsed) {
    return { value: sessionName, label: sessionName };
  }
  const { iteration, role, reviewerIndex } = parsed;
  const roleLabel = role === 'impl' ? '\uD83D\uDD28 Implementer' : `\uD83D\uDD0D Reviewer ${reviewerIndex ?? 0}`;
  return {
    value: sessionName,
    label: `Iteration ${iteration} - ${roleLabel}`,
    hint: sessionName,
  };
}
async function handler8(id, tmux) {
  try {
    if (id) {
      const sessionName = `kloop-${id}`;
      const sessions2 = await tmux.listSessions();
      if (sessions2.includes(sessionName)) {
        const { execSync: execSync2 } = await import('child_process');
        execSync2(`tmux attach -t "${sessionName}"`, { stdio: 'inherit' });
        return;
      }
      console.log(import_picocolors10.default.yellow(`Session "${sessionName}" not found.`));
    }
    const sessions = await tmux.listSessions();
    if (sessions.length === 0) {
      console.log(import_picocolors10.default.yellow('No running agent sessions.'));
      return;
    }
    Ie(import_picocolors10.default.bgCyan(import_picocolors10.default.black(' Attach to Session ')));
    const choices = sessions.map(formatSessionChoice);
    const selected = await ve({
      message: 'Select a session to attach:',
      options: choices,
    });
    if (pD(selected)) {
      xe('Cancelled.');
      process.exit(0);
    }
    Se(`Attaching to ${import_picocolors10.default.cyan(selected)}...`);
    const { execSync } = await import('child_process');
    execSync(`tmux attach -t "${selected}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(import_picocolors10.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/cancel.ts
var import_picocolors11 = __toESM(require_picocolors(), 1);
import * as fs6 from 'fs/promises';
import * as path8 from 'path';
async function handler9(id, deps) {
  try {
    const { tmux, indexDb, eventLog, pidLock, state } = deps;
    let runId;
    if (id) {
      const row = await indexDb.getRun(id);
      if (!row) {
        console.log(`Run not found: ${id}`);
        return;
      }
      runId = row.id;
    } else {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log('No active run for this workspace.');
        return;
      }
      runId = row.id;
    }
    const lock = await pidLock.read(runId);
    const runState = await eventLog.deriveStatus(runId, lock?.pid);
    if (!runState) {
      console.log(`Run ${runId} not found.`);
      return;
    }
    if (eventLog.isTerminal(runState.status)) {
      console.log(`Run ${runId} is already ${runState.status}.`);
      return;
    }
    console.log(`Cancelling run ${runId}...`);
    await eventLog.append(runId, {
      type: EVENT_TYPES.CANCEL,
      timestamp: new Date().toISOString(),
      reason: 'user requested',
    });
    const sessions = await tmux.listSessions();
    let killed = 0;
    for (const session of sessions) {
      const parsed = tmux.parseSessionName(session);
      if ((parsed && parsed.runId === runId) || session.includes(`kloop-${runId}`)) {
        if (await tmux.killSession(session)) {
          killed++;
        }
      }
    }
    if (killed > 0) {
      console.log(`Killed ${killed} tmux session(s)`);
    }
    await pidLock.release(runId);
    const localKloop = path8.join(process.cwd(), '.kloop');
    try {
      const stat = await fs6.lstat(localKloop);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        await fs6.rm(localKloop, { recursive: true, force: true });
        console.log(import_picocolors11.default.dim(`Removed .kloop/`));
      }
    } catch {}
    console.log('Run cancelled.');
  } catch (err) {
    console.error(import_picocolors11.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/link.ts
var import_picocolors12 = __toESM(require_picocolors(), 1);
import * as path9 from 'path';
import * as fs7 from 'fs/promises';
async function handler10(runId, deps) {
  try {
    const { indexDb } = deps;
    if (!runId) {
      const workspace = process.cwd();
      const row2 = await indexDb.getRunByWorkspace(workspace);
      if (!row2) {
        console.log(import_picocolors12.default.yellow('No run found for this workspace.'));
        return;
      }
      runId = row2.id;
    }
    const row = await indexDb.getRun(runId);
    if (!row) {
      console.log(import_picocolors12.default.red(`Run not found: ${runId}`));
      return;
    }
    const localKloop = path9.join(process.cwd(), '.kloop');
    const specTarget = paths.runSpec(runId);
    const configTarget = paths.runConfig(runId);
    if (!(await fileExists3(specTarget))) {
      console.log(import_picocolors12.default.red(`Spec file not found: ${specTarget}`));
      process.exit(1);
    }
    if (await fileExists3(localKloop)) {
      console.log(import_picocolors12.default.yellow(`.kloop/ already exists in this directory. Remove it first.`));
      return;
    }
    await fs7.mkdir(localKloop, { recursive: true });
    const specLink = path9.join(localKloop, 'spec.md');
    await fs7.symlink(specTarget, specLink);
    if (await fileExists3(configTarget)) {
      const configLink = path9.join(localKloop, 'config.yaml');
      await fs7.symlink(configTarget, configLink);
    }
    console.log(import_picocolors12.default.green(`Linked run ${runId} into .kloop/`));
    console.log(import_picocolors12.default.dim(`  .kloop/spec.md \u2192 ${specTarget}`));
    if (await fileExists3(configTarget)) {
      console.log(import_picocolors12.default.dim(`  .kloop/config.yaml \u2192 ${configTarget}`));
    }
    console.log('');
    console.log(import_picocolors12.default.dim('Edit the files, then run:'));
    console.log(import_picocolors12.default.dim(`  kloop run ${runId}`));
  } catch (err) {
    console.error(import_picocolors12.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function fileExists3(p2) {
  try {
    await fs7.access(p2);
    return true;
  } catch {
    return false;
  }
}

// src/cli/logs.ts
var import_picocolors13 = __toESM(require_picocolors(), 1);
import * as fs8 from 'fs/promises';
async function handler11(runId, opts, deps) {
  try {
    const { indexDb } = deps;
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(import_picocolors13.default.yellow('No run found for this workspace.'));
        return;
      }
      runId = row.id;
    }
    const logPath = paths.runLog(runId);
    if (!(await fileExists4(logPath))) {
      console.log(import_picocolors13.default.yellow(`No run log found: ${logPath}`));
      return;
    }
    if (opts.f) {
      const { execSync } = await import('child_process');
      console.log(import_picocolors13.default.dim(`Following: ${logPath}`));
      console.log(import_picocolors13.default.dim('Press Ctrl+C to stop'));
      console.log('');
      execSync(`tail -f "${logPath}"`, { stdio: 'inherit' });
      return;
    }
    let content = await fs8.readFile(logPath, 'utf-8');
    if (opts.since) {
      content = filterSince(content, opts.since, logPath);
    }
    if (!content.trim()) {
      console.log(import_picocolors13.default.yellow('No log entries.'));
      return;
    }
    console.log(import_picocolors13.default.dim(`Run log: ${logPath}`));
    console.log('');
    console.log(content);
  } catch (err) {
    console.error(import_picocolors13.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
function filterSince(content, since, logPath) {
  const cutoff = parseSince(since);
  if (!cutoff) return content;
  console.log(import_picocolors13.default.dim(`--since filtering is approximate (run.log has no per-line timestamps)`));
  return content;
}
function parseSince(since) {
  const d3 = new Date(since);
  if (!isNaN(d3.getTime())) return d3;
  const match2 = since.match(/^(\d+)([smhd])$/);
  if (match2) {
    const val = parseInt(match2[1], 10);
    const unit = match2[2];
    const now = Date.now();
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(now - val * (multipliers[unit] ?? 60000));
  }
  return null;
}
async function fileExists4(p2) {
  try {
    await fs8.access(p2);
    return true;
  } catch {
    return false;
  }
}

// src/cli/view.ts
var import_picocolors14 = __toESM(require_picocolors(), 1);
import * as fs9 from 'fs/promises';
import * as fsSync from 'fs';
import { createReadStream, existsSync, statSync } from 'fs';
import * as readline from 'readline';
import * as path10 from 'path';
async function handler12(runId, loopArg, roleArg, ordinalArg, opts, deps) {
  try {
    const { indexDb } = deps;
    if (!runId) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(import_picocolors14.default.yellow('No run found for this workspace.'));
        return;
      }
      runId = row.id;
    }
    const runDir = paths.runPath(runId);
    if (!(await fileExists5(runDir))) {
      console.log(import_picocolors14.default.red(`Run not found: ${runId}`));
      return;
    }
    const loops = await discoverLoops(runDir);
    if (loops.length === 0) {
      console.log(import_picocolors14.default.yellow('No agent logs found for this run.'));
      return;
    }
    if (!loopArg) {
      const selectedLoop = await promptLoop(loops);
      if (!selectedLoop) return;
      const selectedAgent2 = await promptAgent(selectedLoop.agents);
      if (!selectedAgent2) return;
      await displayLog(selectedAgent2, opts);
      return;
    }
    const loopNum = parseInt(loopArg, 10);
    const loop = loops.find(l2 => l2.loopNum === loopNum);
    if (!loop) {
      console.log(
        import_picocolors14.default.yellow(
          `Loop ${loopNum} not found. Available: ${loops.map(l2 => l2.loopNum).join(', ')}`,
        ),
      );
      return;
    }
    if (roleArg) {
      const agent = resolveAgent(roleArg, ordinalArg, loop);
      if (!agent) {
        console.log(
          import_picocolors14.default.yellow(`Agent not found. Available: ${loop.agents.map(a => a.label).join(', ')}`),
        );
        return;
      }
      await displayLog(agent, opts);
      return;
    }
    const selectedAgent = await promptAgent(loop.agents);
    if (!selectedAgent) return;
    await displayLog(selectedAgent, opts);
  } catch (err) {
    console.error(import_picocolors14.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function discoverLoops(runDir) {
  const entries = await fs9.readdir(runDir);
  const loops = [];
  for (const entry of entries) {
    const match2 = entry.match(/^loop-(\d+)$/);
    if (!match2) continue;
    const loopNum = parseInt(match2[1], 10);
    const loopDir = path10.join(runDir, entry);
    const agents = await discoverAgents(loopDir, loopNum);
    if (agents.length > 0) {
      loops.push({ loopNum, agents });
    }
  }
  return loops.sort((a, b3) => b3.loopNum - a.loopNum);
}
async function discoverAgents(loopDir, _loopNum) {
  const agents = [];
  try {
    const entries = await fs9.readdir(loopDir);
    for (const entry of entries) {
      if (entry === 'evidence' || entry === 'summary.json' || entry === 'summary.md' || entry === 'learning.md')
        continue;
      if (!entry.startsWith('implementer') && !entry.startsWith('reviewer-') && !entry.startsWith('checkpointer'))
        continue;
      const entryPath = path10.join(loopDir, entry);
      const stat2 = await fs9.stat(entryPath).catch(() => null);
      if (!stat2?.isDirectory()) continue;
      const logPath = path10.join(entryPath, 'log');
      const label = entry === 'implementer' ? 'impl' : entry === 'checkpointer' ? 'checkpoint' : entry;
      agents.push({ dirName: entry, label, logPath });
    }
  } catch {}
  return agents;
}
function resolveAgent(roleArg, ordinalArg, loop) {
  if (roleArg === 'impl' || roleArg === 'implementer') {
    return loop.agents.find(a => a.dirName === 'implementer') ?? null;
  }
  if (roleArg === 'rev' || roleArg === 'reviewer') {
    if (ordinalArg === undefined) {
      return loop.agents.find(a => a.dirName === 'reviewer-0') ?? null;
    }
    return loop.agents.find(a => a.dirName === `reviewer-${ordinalArg}`) ?? null;
  }
  return loop.agents.find(a => a.dirName === roleArg) ?? null;
}
async function displayLog(agent, opts) {
  if (opts.f) {
    await followLog(agent, opts);
    return;
  }
  if (!(await fileExists5(agent.logPath))) {
    if (opts.f) return;
    console.log(import_picocolors14.default.yellow(`No log yet \u2014 ${agent.label} may still be starting.`));
    console.log(
      import_picocolors14.default.dim(
        `Try: kloop view ${agent.dirName === 'implementer' ? '1 impl' : '1 ' + agent.dirName} -f`,
      ),
    );
    return;
  }
  let content = await fs9.readFile(agent.logPath, 'utf-8');
  if (opts.since) {
    const cutoff = parseSince2(opts.since);
    if (cutoff) {
      content = filterJsonLogSince(content, cutoff);
    }
  }
  if (!content.trim()) {
    console.log(import_picocolors14.default.yellow('No log entries.'));
    return;
  }
  console.log(import_picocolors14.default.dim(`${agent.label} \u2014 ${agent.logPath}`));
  console.log('');
  displayFormattedLog(content);
}
async function promptLoop(loops) {
  if (loops.length === 1) {
    return loops[0];
  }
  Ie(import_picocolors14.default.bgCyan(import_picocolors14.default.black(' Select Loop ')));
  const choices = loops.map(l2 => ({
    value: l2,
    label: `Loop ${l2.loopNum}`,
    hint: `${l2.agents.length} agent(s)`,
  }));
  const selected = await ve({
    message: 'Select a loop:',
    options: choices,
  });
  if (pD(selected)) {
    xe('Cancelled.');
    return null;
  }
  Se(`Loop ${selected.loopNum}`);
  return selected;
}
async function promptAgent(agents) {
  if (agents.length === 1) {
    return agents[0];
  }
  const choices = agents.map(a => ({
    value: a,
    label: a.label,
    hint: a.dirName,
  }));
  const selected = await ve({
    message: 'Select an agent:',
    options: choices,
  });
  if (pD(selected)) {
    xe('Cancelled.');
    return null;
  }
  return selected;
}
async function followLog(agent, opts) {
  console.log(import_picocolors14.default.dim(`Following: ${agent.label} \u2014 ${agent.logPath}`));
  console.log(import_picocolors14.default.dim('Press Ctrl+C to stop'));
  console.log('');
  const cutoff = opts.since ? parseSince2(opts.since) : null;
  while (!existsSync(agent.logPath)) {
    await Bun.sleep(500);
  }
  let startOffset = 0;
  if (cutoff) {
    try {
      const content = await fs9.readFile(agent.logPath, 'utf-8');
      const lines = content.split(`
`);
      let byteOffset = 0;
      for (const line of lines) {
        byteOffset += Buffer.byteLength(line) + 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const ts = obj.timestamp ?? obj.ts;
          if (ts && new Date(ts).getTime() >= cutoff.getTime()) {
            startOffset = byteOffset;
            break;
          }
        } catch {}
      }
    } catch {}
  }
  const stream = createReadStream(agent.logPath, {
    start: startOffset,
    encoding: 'utf-8',
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    formatLine(line);
  }
  let lastSize = 0;
  try {
    lastSize = statSync(agent.logPath).size;
  } catch {}
  const pollInterval = setInterval(async () => {
    try {
      const currentSize = statSync(agent.logPath).size;
      if (currentSize <= lastSize) return;
      const fd = fsSync.openSync(agent.logPath, 'r');
      const buf = Buffer.alloc(currentSize - lastSize);
      fsSync.readSync(fd, buf, 0, buf.length, lastSize);
      fsSync.closeSync(fd);
      lastSize = currentSize;
      const newContent = buf.toString('utf-8');
      for (const line of newContent.split(`
`)) {
        const trimmed = line.trim();
        if (trimmed) formatLine(trimmed);
      }
    } catch {
      lastSize = 0;
    }
  }, 300);
  const cleanup = () => {
    clearInterval(pollInterval);
    rl.close();
    stream.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => cleanup());
  process.on('SIGTERM', () => cleanup());
}
function formatLine(line) {
  try {
    const obj = JSON.parse(line);
    formatLogEntry(obj);
  } catch {
    console.log(line);
  }
}
function displayFormattedLog(content) {
  const lines = content
    .split(
      `
`,
    )
    .filter(l2 => l2.trim());
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      formatLogEntry(obj);
    } catch {
      console.log(line);
    }
  }
}
function formatLogEntry(entry) {
  switch (entry.type) {
    case 'system':
      formatSystemEntry(entry);
      break;
    case 'assistant':
      formatAssistantEntry(entry);
      break;
    case 'user':
      formatUserEntry(entry);
      break;
    case 'result':
      formatFinalResult(entry);
      break;
    default:
      console.log(import_picocolors14.default.dim(`[${entry.type}]`));
  }
}
function formatSystemEntry(entry) {
  if (entry.subtype === 'init') {
    console.log(
      import_picocolors14.default.yellow(
        '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      ),
    );
    console.log(import_picocolors14.default.yellow('  SESSION START'));
    if (entry.cwd) console.log(import_picocolors14.default.dim(`  cwd: ${entry.cwd}`));
    if (entry.session_id) console.log(import_picocolors14.default.dim(`  session: ${entry.session_id}`));
    console.log(
      import_picocolors14.default.yellow(
        '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      ),
    );
    console.log('');
  } else if (typeof entry.message === 'string') {
    console.log(import_picocolors14.default.yellow(`[system] ${entry.message}`));
  }
}
function formatAssistantEntry(entry) {
  const message2 = entry.message;
  if (!message2?.content) return;
  for (const block of message2.content) {
    if (block.type === 'text' && block.text) {
      console.log('');
      console.log(
        import_picocolors14.default.green(
          '\u250C\u2500 AGENT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
        ),
      );
      for (const line of block.text.split(`
`)) {
        console.log(import_picocolors14.default.green('\u2502 ') + line);
      }
      console.log(
        import_picocolors14.default.green(
          '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
        ),
      );
    } else if (block.type === 'tool_use' && block.name) {
      console.log('');
      console.log(import_picocolors14.default.blue(`  \u26A1 ${block.name}`));
      if (block.input) {
        const formatted = formatToolInput(block.name, block.input);
        for (const line of formatted.split(`
`)) {
          console.log(import_picocolors14.default.dim(`     ${line}`));
        }
      }
    }
  }
}
function formatUserEntry(entry) {
  const message2 = entry.message;
  if (!message2?.content) return;
  for (const block of message2.content) {
    if (block.type === 'tool_result' || block.type === 'tool_use_result') {
      let resultContent = block.content || '';
      let filePath;
      if (entry.tool_use_result?.file?.filePath) {
        filePath = entry.tool_use_result.file.filePath;
      }
      const lines = resultContent.split(`
`);
      const maxLines = 15;
      const truncated = lines.length > maxLines;
      const displayLines = truncated ? lines.slice(0, maxLines) : lines;
      if (filePath) {
        console.log(import_picocolors14.default.dim(`     \u21B3 ${filePath}`));
      }
      for (const line of displayLines) {
        const cleanLine = line.replace(/^\s*\d+\u2192/, '');
        const truncatedLine = cleanLine.length > 100 ? cleanLine.slice(0, 100) + '...' : cleanLine;
        console.log(import_picocolors14.default.dim(`     \u2502 ${truncatedLine}`));
      }
      if (truncated) {
        console.log(import_picocolors14.default.dim(`     \u2502 ... (${lines.length - maxLines} more lines)`));
      }
    }
  }
}
function formatFinalResult(entry) {
  console.log('');
  console.log(
    import_picocolors14.default.magenta(
      '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    ),
  );
  console.log(import_picocolors14.default.magenta('  SESSION COMPLETE'));
  console.log(
    import_picocolors14.default.magenta(
      '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    ),
  );
  if (entry.duration_ms) {
    const mins = Math.floor(entry.duration_ms / 60000);
    const secs = Math.floor((entry.duration_ms % 60000) / 1000);
    console.log(import_picocolors14.default.dim(`  Duration: ${mins}m ${secs}s`));
  }
  if (entry.num_turns) {
    console.log(import_picocolors14.default.dim(`  Turns: ${entry.num_turns}`));
  }
  if (entry.total_cost_usd) {
    console.log(import_picocolors14.default.dim(`  Cost: $${entry.total_cost_usd.toFixed(2)}`));
  }
  if (entry.result) {
    console.log('');
    console.log(import_picocolors14.default.white('  Result:'));
    for (const line of entry.result.split(`
`)) {
      console.log(`  ${line}`);
    }
  }
  console.log('');
}
function formatToolInput(toolName, input) {
  switch (toolName) {
    case 'Read':
      return `${input.file_path}`;
    case 'Write': {
      const content = input.content;
      const preview =
        content
          ?.split(
            `
`,
          )
          .slice(0, 5).join(`
`) || '';
      return `${input.file_path}
${truncateMultiline(preview, 200)}`;
    }
    case 'Edit':
      return `${input.file_path}
- ${truncateMultiline(input.old_string, 100)}
+ ${truncateMultiline(input.new_string, 100)}`;
    case 'Bash':
      return `$ ${input.command}`;
    case 'Glob':
      return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'Grep':
      return `/${input.pattern}/${input.path ? ` in ${input.path}` : ''}`;
    case 'TodoWrite': {
      const todos = input.todos;
      if (todos) {
        return todos.map(t => {
          const icon = t.status === 'completed' ? '\u2713' : t.status === 'in_progress' ? '\u2192' : '\u25CB';
          return `${icon} ${t.content}`;
        }).join(`
`);
      }
      return JSON.stringify(input);
    }
    case 'Task':
      return `[${input.subagent_type}] ${input.description || ''}
${truncateMultiline(input.prompt, 150)}`;
    default: {
      const json = JSON.stringify(input);
      return json.length > 200 ? json.slice(0, 200) + '...' : json;
    }
  }
}
function filterJsonLogSince(content, cutoff) {
  const lines = content.split(`
`);
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      const obj = JSON.parse(trimmed);
      const ts = obj.timestamp ?? obj.ts;
      if (ts) {
        return new Date(ts).getTime() >= cutoff.getTime();
      }
      return true;
    } catch {
      return true;
    }
  });
  return filtered.join(`
`);
}
function parseSince2(since) {
  const d3 = new Date(since);
  if (!isNaN(d3.getTime())) return d3;
  const match2 = since.match(/^(\d+)([smhd])$/);
  if (match2) {
    const val = parseInt(match2[1], 10);
    const unit = match2[2];
    const now = Date.now();
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return new Date(now - val * (multipliers[unit] ?? 60000));
  }
  return null;
}
function truncateMultiline(str, maxLen) {
  if (!str) return '';
  const single = str.replace(/\n/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen) + '...';
}
async function fileExists5(p2) {
  try {
    await fs9.access(p2);
    return true;
  } catch {
    return false;
  }
}

// src/cli/remove.ts
var import_picocolors15 = __toESM(require_picocolors(), 1);
async function handler13(ids, opts, deps) {
  try {
    const { indexDb, eventLog, pidLock, tmux, state } = deps;
    if (ids.length === 0) {
      const workspace = process.cwd();
      const row = await indexDb.getRunByWorkspace(workspace);
      if (!row) {
        console.log(import_picocolors15.default.yellow('No run found for this workspace.'));
        return;
      }
      ids = [row.id];
    }
    const allRuns = await indexDb.listRuns();
    const resolvedIds = [];
    for (const rawId of ids) {
      const exact = allRuns.find(r2 => r2.id === rawId);
      if (exact) {
        resolvedIds.push(exact.id);
        continue;
      }
      const matches = allRuns.filter(r2 => r2.id.startsWith(rawId));
      if (matches.length === 1) {
        resolvedIds.push(matches[0].id);
        continue;
      }
      if (matches.length > 1) {
        console.log(
          import_picocolors15.default.yellow(
            `Ambiguous prefix "${rawId}" matches ${matches.length} runs: ${matches.map(m2 => m2.id).join(', ')}`,
          ),
        );
        continue;
      }
      console.log(import_picocolors15.default.red(`Run not found: ${rawId}`));
    }
    if (resolvedIds.length === 0) {
      console.log(import_picocolors15.default.yellow('Nothing to remove.'));
      return;
    }
    let removed = 0;
    for (const runId of resolvedIds) {
      const lock = await pidLock.read(runId);
      const runState = await eventLog.deriveStatus(runId, lock?.pid);
      if (runState?.status === 'crashed') {
        await reapDeadRun(runId, eventLog, pidLock, tmux);
        const updatedState = await eventLog.deriveStatus(runId);
        if (updatedState && !eventLog.isTerminal(updatedState.status) && !opts.force) {
          console.log(
            import_picocolors15.default.yellow(`Run ${runId} is still ${updatedState.status}. Use --force to remove.`),
          );
          continue;
        }
      } else if (runState && !eventLog.isTerminal(runState.status) && !opts.force) {
        console.log(
          import_picocolors15.default.yellow(`Run ${runId} is still ${runState.status}. Use --force to remove.`),
        );
        continue;
      }
      const runDir = paths.runPath(runId);
      if (await state.fs.exists(runDir)) {
        await state.fs.rm(runDir, { recursive: true });
      }
      await pidLock.release(runId);
      await indexDb.removeRun(runId);
      console.log(import_picocolors15.default.green(`Removed ${runId}`));
      removed++;
    }
    if (removed > 0) {
      console.log(import_picocolors15.default.dim(`Removed ${removed} run(s).`));
    }
  } catch (err) {
    console.error(import_picocolors15.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/review.ts
var import_picocolors17 = __toESM(require_picocolors(), 1);

// src/cli/shared.ts
var import_picocolors16 = __toESM(require_picocolors(), 1);
var CLAUDE_AUTO_PREFIX2 = 'claude-auto-';
function shortBinary4(binary, harness) {
  const name = binary.startsWith(CLAUDE_AUTO_PREFIX2) ? binary.slice(CLAUDE_AUTO_PREFIX2.length) : binary;
  if (harness && harness !== 'claude') return `${name}:${harness}`;
  return name;
}
async function loadLoopSummaries(runId, fs10) {
  const runDir = paths.runPath(runId);
  const summaries = [];
  try {
    const entries = await fs10.readdir(runDir);
    const loopDirs = entries
      .map(e2 => ({ match: e2.match(/^loop-(\d+)$/), name: e2 }))
      .filter(e2 => e2.match)
      .sort((a, b3) => parseInt(a.match[1], 10) - parseInt(b3.match[1], 10));
    for (const { match: match2 } of loopDirs) {
      const loopNum = parseInt(match2[1], 10);
      const summaryPath = paths.loopSummaryJson(runId, loopNum);
      if (await fs10.exists(summaryPath)) {
        const summary = await fs10.readJson(summaryPath);
        if (summary) summaries.push(summary);
      }
    }
  } catch {}
  return summaries;
}
function verdictMark3(verdict) {
  if (verdict === 'approved') return import_picocolors16.default.green('\u2713');
  if (verdict === 'rejected') return import_picocolors16.default.red('\u2717');
  return import_picocolors16.default.dim('\xB7');
}

// src/cli/review.ts
async function handler14(id, opts, deps) {
  try {
    const { indexDb, state } = deps;
    let runId = opts.run ?? id;
    if (!runId) {
      const workspace = process.cwd();
      const row2 = await indexDb.getRunByWorkspace(workspace);
      if (!row2) {
        console.log(import_picocolors17.default.yellow('No run found for this workspace.'));
        return;
      }
      runId = row2.id;
    }
    const row = await indexDb.getRun(runId);
    if (!row) {
      console.log(import_picocolors17.default.red(`Run not found: ${runId}`));
      return;
    }
    const summaries = await loadLoopSummaries(runId, state.fs);
    if (summaries.length === 0) {
      console.log(import_picocolors17.default.yellow('No loop summaries found for this run.'));
      return;
    }
    console.log(
      import_picocolors17.default.bold(`Run ${runId} \u2014 Review Verdicts
`),
    );
    for (const summary of summaries) {
      console.log(
        import_picocolors17.default.bold(`Iteration ${summary.loop}`) +
          import_picocolors17.default.dim(` (${formatDurationHuman(summary.durationMs)})`),
      );
      const impl = summary.implementer;
      const implStatus =
        impl.exitCode === 0
          ? import_picocolors17.default.green('success')
          : import_picocolors17.default.red(`exit ${impl.exitCode}`);
      console.log(
        `  ${import_picocolors17.default.dim('impl')}  ${shortBinary4(impl.binary)}  ${implStatus}  ${formatDurationHuman(impl.durationMs)}`,
      );
      for (const phase of summary.reviewPhases) {
        for (const r2 of phase.reviewers) {
          const mark = verdictMark3(r2.verdict);
          const comp = r2.completionEstimate !== undefined ? ` ${r2.completionEstimate}% done` : '';
          const note = r2.timedOut
            ? import_picocolors17.default.yellow(' (timed out)')
            : r2.error
              ? import_picocolors17.default.red(` (${r2.error})`)
              : '';
          console.log(
            `  ${mark} ${import_picocolors17.default.dim('rev')}  ${shortBinary4(r2.binary)}  ${formatDurationHuman(r2.durationMs)}${comp}${note}`,
          );
          if (r2.reasoning) {
            const lines = r2.reasoning.split(`
`);
            for (const line of lines) {
              console.log(import_picocolors17.default.dim(`      \u2502 ${line}`));
            }
          }
        }
      }
      console.log('');
    }
  } catch (err) {
    console.error(import_picocolors17.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/summary.ts
var import_picocolors18 = __toESM(require_picocolors(), 1);
function buildDataSummary(runId, startedAt, status, exitReason, maxIterations, summaries, learnings) {
  const startDate = new Date(startedAt);
  const startedStr = format(startDate, 'MMM dd, HH:mm');
  const totalDurationMs = summaries.reduce((sum, s) => sum + s.durationMs, 0);
  const durationStr = formatDurationHuman(totalDurationMs);
  const lastSummary = summaries[summaries.length - 1];
  const completedStr = lastSummary ? format(new Date(startDate.getTime() + totalDurationMs), 'MMM dd, HH:mm') : '';
  const verdict =
    exitReason === 'consensus'
      ? 'approved (consensus)'
      : exitReason === 'max_iterations'
        ? 'max iterations reached'
        : (exitReason ?? status);
  let md = `# Run Summary: ${runId}

`;
  md += `## Overview
`;
  md += `- **Status**: ${status} (${verdict})
`;
  md += `- **Duration**: ${durationStr}
`;
  md += `- **Iterations**: ${summaries.length}${maxIterations ? ` / ${maxIterations}` : ''}
`;
  md += `- **Started**: ${startedStr}
`;
  if (completedStr)
    md += `- **Completed**: ${completedStr}
`;
  md += `
`;
  for (const summary of summaries) {
    md += `## Iteration ${summary.loop} (${formatDurationHuman(summary.durationMs)})

`;
    const impl = summary.implementer;
    const implStatus = impl.exitCode === 0 ? 'success' : `exit ${impl.exitCode}`;
    md += `**Implementer** (${shortBinary4(impl.binary)}): ${implStatus}, ${formatDurationHuman(impl.durationMs)}

`;
    for (const phase of summary.reviewPhases) {
      for (const r2 of phase.reviewers) {
        const vLabel = r2.verdict ?? 'no verdict';
        const comp = r2.completionEstimate !== undefined ? `, ${r2.completionEstimate}% complete` : '';
        const note = r2.timedOut ? ' (timed out)' : r2.error ? ` (${r2.error})` : '';
        md += `**Review** (${shortBinary4(r2.binary)}): ${vLabel}${comp}${note}, ${formatDurationHuman(r2.durationMs)}
`;
        if (r2.reasoning) {
          md += `> ${r2.reasoning.replace(
            /\n/g,
            `
> `,
          )}
`;
        }
        md += `
`;
      }
    }
    if (summary.checkpoint) {
      const ck = summary.checkpoint;
      const ckLabel = `${ck.outcome}${ck.progressPercent !== undefined ? ` \u2014 ${ck.progressPercent}% progress` : ''}`;
      md += `**Checkpoint**: ${ckLabel}
`;
      if (ck.summary)
        md += `> ${ck.summary.replace(
          /\n/g,
          `
> `,
        )}
`;
      md += `
`;
    }
    md += `
`;
  }
  if (learnings) {
    const lines = learnings
      .split(
        `
`,
      )
      .filter(l2 => l2.trim() && !l2.startsWith('#'));
    if (lines.length > 0) {
      md += `## Learnings

`;
      for (const line of lines) {
        md += `- ${line.replace(/^[-*]\s*/, '')}
`;
      }
      md += `
`;
    }
  }
  return md;
}
function buildSummaryPrompt(runId, startedAt, status, exitReason, maxIterations, summaries, learnings, spec) {
  const startDate = new Date(startedAt);
  const startedStr = format(startDate, 'MMM dd, HH:mm');
  const totalDurationMs = summaries.reduce((sum, s) => sum + s.durationMs, 0);
  const durationStr = formatDurationHuman(totalDurationMs);
  const lastSummary = summaries[summaries.length - 1];
  const completedStr = lastSummary ? format(new Date(startDate.getTime() + totalDurationMs), 'MMM dd, HH:mm') : '';
  const verdict =
    exitReason === 'consensus'
      ? 'approved (consensus)'
      : exitReason === 'max_iterations'
        ? 'max iterations reached'
        : (exitReason ?? status);
  let prompt = `You are generating a run summary for an automated development loop. Based on the data below, write a concise narrative summary in markdown format.

The summary should:
1. Start with an Overview section (status, duration, iterations, started/completed dates)
2. For each iteration, write a short narrative paragraph describing what the implementer did, what reviewers found, and any checkpoint outcomes. Use the reviewer reasoning text to understand what was accomplished.
3. Keep each iteration to 2-4 sentences.
4. End with a Learnings section if there are any.

# Run Data
- **Run ID**: ${runId}
- **Status**: ${status} (${verdict})
- **Duration**: ${durationStr}
- **Iterations**: ${summaries.length}${maxIterations ? ` / ${maxIterations}` : ''}
- **Started**: ${startedStr}${
    completedStr
      ? `
- **Completed**: ${completedStr}`
      : ''
  }

# Loop Iteration Data
`;
  for (const summary of summaries) {
    prompt += `
## Iteration ${summary.loop} (${formatDurationHuman(summary.durationMs)})

`;
    const impl = summary.implementer;
    const implStatus = impl.exitCode === 0 ? 'success' : `failed (exit ${impl.exitCode})`;
    prompt += `**Implementer** (${shortBinary4(impl.binary)}): ${implStatus}, ${formatDurationHuman(impl.durationMs)}
`;
    for (const phase of summary.reviewPhases) {
      for (const r2 of phase.reviewers) {
        const vLabel = r2.verdict ?? 'no verdict';
        const comp = r2.completionEstimate !== undefined ? `, ${r2.completionEstimate}% complete` : '';
        const note = r2.timedOut ? ' (timed out)' : r2.error ? ` (${r2.error})` : '';
        prompt += `**Review** (${shortBinary4(r2.binary)}): ${vLabel}${comp}${note}, ${formatDurationHuman(r2.durationMs)}
`;
        if (r2.reasoning) {
          prompt += `Reasoning: ${r2.reasoning}
`;
        }
      }
    }
    if (summary.checkpoint) {
      const ck = summary.checkpoint;
      prompt += `
**Checkpoint**: ${ck.outcome}${ck.progressPercent !== undefined ? ` (${ck.progressPercent}% progress)` : ''}
`;
      if (ck.summary)
        prompt += `Summary: ${ck.summary}
`;
    }
  }
  if (learnings) {
    prompt += `
# Learnings
${learnings}
`;
  }
  if (spec) {
    prompt += `
# Spec
${spec}
`;
  }
  prompt += `
Generate the summary markdown now. Start with "# Run Summary: ${runId}". Do not wrap in code fences.`;
  return prompt;
}
async function generateLlmSummary(binary, prompt) {
  try {
    const proc = Bun.spawn([binary, '--print', '--dangerously-skip-permissions'], {
      cwd: process.cwd(),
      stdin: Buffer.from(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      if (process.env.DEBUG)
        console.error(
          import_picocolors18.default.dim(`LLM summary failed (exit ${exitCode}): ${stderr.slice(0, 200)}`),
        );
      return null;
    }
    return output.trim();
  } catch (err) {
    if (process.env.DEBUG) console.error(import_picocolors18.default.dim(`LLM summary error: ${err.message}`));
    return null;
  }
}
async function handler15(id, opts, deps) {
  try {
    const { indexDb, eventLog, pidLock, state } = deps;
    let runId = opts.run ?? id;
    if (!runId) {
      const workspace = process.cwd();
      const row2 = await indexDb.getRunByWorkspace(workspace);
      if (!row2) {
        console.log(import_picocolors18.default.yellow('No run found for this workspace.'));
        return;
      }
      runId = row2.id;
    }
    const row = await indexDb.getRun(runId);
    if (!row) {
      console.log(import_picocolors18.default.red(`Run not found: ${runId}`));
      return;
    }
    const lock = await pidLock.read(runId);
    const runState = await eventLog.deriveStatus(runId, lock?.pid);
    const summaries = await loadLoopSummaries(runId, state.fs);
    if (summaries.length === 0) {
      console.log(import_picocolors18.default.yellow('No loop summaries found for this run.'));
      return;
    }
    const summaryPath = `${paths.runPath(runId)}/summary.md`;
    const exists = await state.fs.exists(summaryPath);
    if (exists && !opts.force) {
      const content = await state.fs.readFile(summaryPath);
      console.log(content);
      console.log(
        import_picocolors18.default.dim(`
(summary already exists \u2014 use --force to regenerate)`),
      );
      return;
    }
    let learnings = null;
    const learningsPath = paths.runLearnings(runId);
    if (await state.fs.exists(learningsPath)) {
      learnings = await state.fs.readFile(learningsPath);
    }
    let spec = null;
    const specPath = paths.runSpec(runId);
    if (await state.fs.exists(specPath)) {
      spec = await state.fs.readFile(specPath);
    }
    const startedAt = runState?.startedAt ?? row.started_at;
    const status = runState?.status ?? 'unknown';
    const exitReason = runState?.exitReason;
    const maxIterations = runState?.config?.maxIterations;
    const config = runState?.config;
    let md = null;
    if (config) {
      const implBinary = Object.keys(config.implementers)[0];
      console.log(
        import_picocolors18.default.dim(`Generating LLM-evaluated summary via ${shortBinary4(implBinary)}...`),
      );
      const prompt = buildSummaryPrompt(
        runId,
        startedAt,
        status,
        exitReason,
        maxIterations,
        summaries,
        learnings,
        spec,
      );
      md = await generateLlmSummary(implBinary, prompt);
      if (md) {
        console.log(import_picocolors18.default.dim('LLM summary generated successfully.'));
      } else {
        console.log(import_picocolors18.default.yellow('LLM summary failed, falling back to data-driven summary.'));
      }
    }
    if (!md) {
      md = buildDataSummary(runId, startedAt, status, exitReason, maxIterations, summaries, learnings);
    }
    await state.fs.writeFile(summaryPath, md);
    console.log(md);
  } catch (err) {
    console.error(import_picocolors18.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/reset.ts
var import_picocolors19 = __toESM(require_picocolors(), 1);
import * as path11 from 'path';
import * as fs10 from 'fs/promises';
async function handler16() {
  try {
    const kloopHome = getKloopHome();
    const defaultsPath = path11.join(kloopHome, 'config.yaml');
    await fs10.mkdir(kloopHome, { recursive: true });
    await fs10.writeFile(defaultsPath, buildDefaultConfigYaml(), 'utf-8');
    console.log(import_picocolors19.default.green('Global config reset to defaults:'));
    console.log(import_picocolors19.default.dim(`  ${defaultsPath}`));
  } catch (err) {
    console.error(import_picocolors19.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// src/cli/stream.ts
var import_picocolors21 = __toESM(require_picocolors(), 1);

// src/stream/format.ts
var import_picocolors20 = __toESM(require_picocolors(), 1);
function formatEvent(event) {
  switch (event.type) {
    case 'system':
      if (event.message) {
        return import_picocolors20.default.dim(`[system] ${event.message}`);
      }
      if (event.subtype === 'init' && event.session_id) {
        return import_picocolors20.default.dim(`[system:init session_id=${event.session_id}]`);
      }
      return import_picocolors20.default.dim(`[system]`);
    case 'user':
      return formatUserMessage(event.message.content);
    case 'assistant':
      return formatAssistantMessage(event.message.content);
    case 'result':
      return formatResult(event.result);
    case 'error':
      return import_picocolors20.default.red(`[error] ${event.error.message}`);
    case 'unknown':
      return null;
  }
}
function formatUserMessage(content) {
  if (typeof content === 'string') {
    const truncated = content.length > 200 ? content.slice(0, 200) + '...' : content;
    return import_picocolors20.default.cyan(`\u25B6 ${truncated.replace(/\n/g, ' ')}`);
  }
  const text = extractText(content);
  if (text) {
    const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
    return import_picocolors20.default.cyan(`\u25B6 ${truncated.replace(/\n/g, ' ')}`);
  }
  const toolResults = content.filter(c => c.type === 'tool_use_result' || c.type === 'tool_result');
  if (toolResults.length > 0) {
    return import_picocolors20.default.dim(`  \u21B3 ${toolResults.length} tool result(s)`);
  }
  return '';
}
function formatAssistantMessage(content) {
  const parts = [];
  const text = extractText(content);
  if (text) {
    parts.push(text);
  }
  const tools = extractToolUses(content);
  for (const tool of tools) {
    parts.push(import_picocolors20.default.yellow(`[${tool.name}]`) + formatToolInput2(tool.input));
  }
  return parts.join(`
`);
}
function formatToolInput2(input) {
  if (!input || typeof input !== 'object') return '';
  const o2 = input;
  if ('command' in o2 && typeof o2.command === 'string') {
    return import_picocolors20.default.dim(` $ ${o2.command.slice(0, 80)}`);
  }
  if ('file_path' in o2 && typeof o2.file_path === 'string') {
    return import_picocolors20.default.dim(` ${o2.file_path}`);
  }
  if ('pattern' in o2 && typeof o2.pattern === 'string') {
    return import_picocolors20.default.dim(` ${o2.pattern}`);
  }
  return '';
}
function formatResult(result) {
  const parts = [];
  if (result.duration_ms) {
    const secs = (result.duration_ms / 1000).toFixed(1);
    parts.push(`${secs}s`);
  }
  if (result.cost_usd) {
    parts.push(`$${result.cost_usd.toFixed(4)}`);
  }
  return import_picocolors20.default.dim(`[done] ${parts.join(' | ')}`);
}

// src/cli/stream.ts
var RETRY_PATTERN = /Attempt \d+ failed.*Retrying after/i;
var MAX_CONSECUTIVE_RETRIES = 5;
async function handler17() {
  const decoder = new TextDecoder();
  let buffer = '';
  let consecutiveRetries = 0;
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    const lines = buffer.split(`
`);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const action = processLine(line);
      if (action === 'retry') {
        consecutiveRetries++;
        if (consecutiveRetries >= MAX_CONSECUTIVE_RETRIES) {
          console.error(
            import_picocolors21.default.red(
              `[kloop] Detected ${MAX_CONSECUTIVE_RETRIES} consecutive retries \u2014 aborting.`,
            ),
          );
          process.exit(1);
        }
      } else if (action === 'progress') {
        consecutiveRetries = 0;
      }
    }
  }
  if (buffer.trim()) {
    processLine(buffer);
  }
}
function processLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return 'skip';
  const event = tryParseJson(trimmed);
  if (event) {
    const formatted = formatEvent(event);
    if (formatted) {
      console.log(formatted);
    }
    return 'progress';
  }
  if (RETRY_PATTERN.test(trimmed)) {
    console.log(import_picocolors21.default.yellow(trimmed));
    return 'retry';
  }
  return 'skip';
}

// src/cli/index.ts
import { readFileSync } from 'fs';
var pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
function createCli(deps) {
  const program2 = new Command()
    .name('kloop')
    .description('Spec-driven development with multi-reviewer consensus')
    .version(pkg.version);
  program2
    .command('setup')
    .description('View or set user-level default config')
    .option('--config <path>', 'import a config file as defaults')
    .action(async opts => handler2(opts));
  program2
    .command('init')
    .description('Create a new run directory with config.yaml + spec.md')
    .option('--workspace <path>', 'specify workspace (defaults to CWD)')
    .option('--spec <path>', 'spec file to use (instead of template)')
    .option('--config <path>', 'config file to use (instead of defaults)')
    .action(async opts => handler(opts, deps.state, deps.indexDb, deps.eventLog));
  program2
    .command('run [id]')
    .description('Start a run')
    .option('-d, --detach', 'run in background (daemon mode)')
    .action(async (id, opts) => handler3(id, opts, deps));
  program2
    .command('ps')
    .description('List active (running) runs')
    .option('-a, --all', 'list all runs (running + completed)')
    .option('--workspace <path>', 'filter by workspace')
    .option('--json', 'machine-readable output')
    .action(async opts => handler4(opts, deps));
  program2
    .command('status [id]')
    .description('Current snapshot of a run (derived from events.jsonl)')
    .option('--json', 'machine-readable output')
    .action(async (id, opts) => handler5(id, opts, deps));
  program2
    .command('describe [id]')
    .description('Full history: all loops, verdicts, exit code, timings')
    .option('--json', 'machine-readable full report')
    .action(async (id, opts) => handler6(id, opts, deps));
  program2
    .command('logs [id]')
    .description('Show kloop run log')
    .option('-f', 'follow mode (tail -f)')
    .option('--since <duration|iso>', 'show entries since (e.g. 5m, 1h, 2026-03-25T21:00:00Z)')
    .action(async (id, opts) => handler11(id, opts, deps));
  program2
    .command('cancel [id]')
    .description('Cancel a run (logged as event)')
    .action(async id => handler9(id, deps));
  program2
    .command('link [id]')
    .description('Symlink run spec+config into CWD/.kloop/ for editing')
    .action(async id => handler10(id, deps));
  program2
    .command('attach [id]')
    .description("Attach to run's tmux session (name: kloop-{runId})")
    .action(async id => handler8(id, deps.tmux));
  program2
    .command('metrics [query]')
    .description('Query metrics with optional promql-style aggregation')
    .option('--run <id>', 'run ID (default: current workspace)')
    .option('--json', 'machine-readable output')
    .action(async (query, opts) => handler7(query, opts, deps));
  program2
    .command('remove [ids...]')
    .alias('rm')
    .description('Delete run(s) \u2014 supports multiple ids and prefix matching')
    .option('--force', 'force remove even if run is active')
    .action(async (ids, opts) => handler13(ids, opts, deps));
  program2
    .command('view [id] [loop] [role] [ordinal]')
    .description('View agent logs (impl, rev-0, etc.)')
    .option('-f', 'follow mode (tail -f)')
    .option('--since <duration|iso>', 'show entries since (e.g. 5m, 1h)')
    .action(async (id, loop, role, ordinal, opts) => handler12(id, loop, role, ordinal, opts, deps));
  program2
    .command('review [id]')
    .description('Show reviewer verdicts and reasoning for each iteration')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, opts) => handler14(id, opts, deps));
  program2
    .command('summary [id]')
    .description('Generate/show LLM-evaluated run summary')
    .option('--force', 'regenerate summary even if it already exists')
    .option('--run <id>', 'run ID (default: current workspace)')
    .action(async (id, opts) => handler15(id, opts, deps));
  program2
    .command('reset')
    .description('Reset global config (~/.kloop/config.yaml) to defaults')
    .action(async () => handler16());
  program2
    .command('stream')
    .description('Process streaming JSON from stdin (internal use)')
    .action(async () => handler17());
  return program2;
}

// src/state/config.ts
function mergeConfig(partial, existing) {
  const raw = {};
  if (existing) {
    raw.implementers = existing.implementers;
    raw.reviewPhases = existing.reviewPhases;
    raw.conflictChecker = existing.conflictChecker;
    raw.maxIterations = existing.maxIterations;
    raw.implementerTimeout = existing.implementerTimeout;
    raw.reviewerTimeout = existing.reviewerTimeout;
    raw.conflictCheckThreshold = existing.conflictCheckThreshold;
  }
  if (partial.implementers) raw.implementers = partial.implementers;
  if (partial.implementer) raw.implementer = partial.implementer;
  if (partial.reviewPhases) {
    raw.reviewPhases = partial.reviewPhases;
    delete raw.reviewers;
  }
  if (partial.reviewers) {
    raw.reviewers = partial.reviewers;
    delete raw.reviewPhases;
  }
  if (partial.conflictChecker !== undefined) raw.conflictChecker = partial.conflictChecker;
  if (partial.maxIterations !== undefined) raw.maxIterations = partial.maxIterations;
  if (partial.implementerTimeout !== undefined) raw.implementerTimeout = partial.implementerTimeout;
  if (partial.reviewerTimeout !== undefined) raw.reviewerTimeout = partial.reviewerTimeout;
  if (partial.conflictCheckThreshold !== undefined) raw.conflictCheckThreshold = partial.conflictCheckThreshold;
  if (partial.firstLoopFullReview !== undefined) raw.firstLoopFullReview = partial.firstLoopFullReview;
  if (partial.previousReviewPropagation !== undefined)
    raw.previousReviewPropagation = partial.previousReviewPropagation;
  if (partial.prompts) raw.prompts = partial.prompts;
  return parseRawConfig(raw);
}

// src/state/service.ts
class StateService {
  paths;
  fs;
  constructor(fs11, paths2) {
    this.paths = paths2;
    this.fs = fs11;
  }
  async initProject(overrides = {}) {
    await this.fs.mkdir(this.paths.baseDir);
    await this.fs.mkdir(this.paths.historyDir);
    await this.fs.mkdir(this.paths.metricsDir);
    if (!(await this.fs.exists(this.paths.spec))) {
      await this.fs.writeFile(this.paths.spec, SPEC_TEMPLATE);
    }
    if (await this.fs.exists(this.paths.config)) {
      const existing = await this.loadConfig();
      await this.saveConfig(mergeConfig(overrides, existing));
    } else {
      await this.saveConfig(mergeConfig(overrides));
    }
  }
  async hasConfig() {
    return this.fs.exists(this.paths.config);
  }
  async loadConfig() {
    const content = await this.fs.readFile(this.paths.config);
    return parseRawConfig(JSON.parse(content));
  }
  async saveConfig(cfg) {
    await this.fs.writeJson(this.paths.config, cfg);
  }
  async hasCurrentRun() {
    return this.fs.exists(this.paths.runJson);
  }
  async createRun(specPath) {
    await this.fs.mkdir(this.paths.currentDir);
    await this.fs.mkdir(this.paths.sessionsDir);
    await this.fs.mkdir(this.paths.verdictsDir);
    await this.fs.mkdir(this.paths.evidenceDir);
    const run = {
      id: generateRunId(),
      spec: specPath,
      status: 'running',
      iteration: 0,
      phase: 'implementing',
      startedAt: getCurrentTimestamp(),
      learnings: [],
      consecutiveFailures: 0,
    };
    await this.saveRun(run);
    return run;
  }
  async loadRun() {
    if (!(await this.fs.exists(this.paths.runJson))) return null;
    const content = await this.fs.readFile(this.paths.runJson);
    return parseRun(JSON.parse(content));
  }
  async saveRun(run) {
    await this.fs.writeJson(this.paths.runJson, run);
  }
  async updatePhase(phase) {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.phase = phase;
    await this.saveRun(run);
  }
  async incrementIteration() {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.iteration += 1;
    await this.saveRun(run);
    return run.iteration;
  }
  async incrementConsecutiveFailures() {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.consecutiveFailures = (run.consecutiveFailures ?? 0) + 1;
    await this.saveRun(run);
    return run.consecutiveFailures;
  }
  async resetConsecutiveFailures() {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.consecutiveFailures = 0;
    await this.saveRun(run);
  }
  async addLearning(learning) {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.learnings.push(learning);
    await this.saveRun(run);
  }
  async completeRun(statusOrCheckpointRan, checkpointRanFlag) {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    let checkpointRan = false;
    if (typeof statusOrCheckpointRan === 'string') {
      run.status = statusOrCheckpointRan;
      if (typeof checkpointRanFlag === 'boolean') {
        checkpointRan = checkpointRanFlag;
      }
    } else if (typeof statusOrCheckpointRan === 'boolean') {
      checkpointRan = statusOrCheckpointRan;
    }
    run.phase = 'done';
    await this.saveRun(run);
    return await this.archiveRun(checkpointRan);
  }
  async cancelRun() {
    const run = await this.loadRun();
    if (!run) return;
    run.status = 'cancelled';
    run.phase = 'done';
    await this.saveRun(run);
  }
  async saveSession(session) {
    await this.fs.writeJson(this.paths.sessionFile(session.id), session);
  }
  async loadSessions() {
    if (!(await this.fs.exists(this.paths.sessionsDir))) return [];
    const files = await this.fs.readdir(this.paths.sessionsDir);
    const sessions = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await this.fs.readFile(`${this.paths.sessionsDir}/${file}`);
        sessions.push(parseSession(JSON.parse(content)));
      } catch (err) {
        if (process.env.DEBUG) console.error(`Failed to parse session ${file}:`, err);
      }
    }
    return sessions;
  }
  async clearVerdicts(iteration) {
    if (!(await this.fs.exists(this.paths.verdictsDir))) return;
    const files = await this.fs.readdir(this.paths.verdictsDir);
    const pattern = new RegExp(`^${iteration}-\\d+\\.json$`);
    for (const file of files) {
      if (pattern.test(file)) {
        await this.fs.unlink(`${this.paths.verdictsDir}/${file}`);
      }
    }
  }
  async clearEvidence() {
    if (await this.fs.exists(this.paths.evidenceDir)) {
      const files = await this.fs.readdir(this.paths.evidenceDir);
      for (const file of files) {
        await this.fs.unlink(`${this.paths.evidenceDir}/${file}`);
      }
    }
    await this.fs.mkdir(this.paths.evidenceDir);
  }
  async clearReviews() {
    const reviewsDir = `${this.paths.currentDir}/reviews`;
    if (await this.fs.exists(reviewsDir)) {
      const files = await this.fs.readdir(reviewsDir);
      for (const file of files) {
        await this.fs.unlink(`${reviewsDir}/${file}`);
      }
    }
    await this.fs.mkdir(reviewsDir);
  }
  async loadArchivedReviews(runId, iteration) {
    const runReviewsDir = this.paths.runReviewsDir(runId);
    if (!(await this.fs.exists(runReviewsDir))) return null;
    const files = await this.fs.readdir(runReviewsDir);
    const reviewFiles = files.filter(f => f.startsWith(`review-${iteration}-`) && f.endsWith('.md')).sort();
    if (reviewFiles.length === 0) return null;
    const sections = [];
    for (const file of reviewFiles) {
      const content = await this.fs.readFile(`${runReviewsDir}/${file}`);
      sections.push(`### ${file}

${content}`);
    }
    return sections.join(`

---

`);
  }
  async saveCheckpointResult(result, iteration) {
    const checkpointResultPath = `${this.paths.currentDir}/checkpoint-result.json`;
    await this.fs.writeJson(checkpointResultPath, result);
    if (iteration !== undefined) {
      const iterationCheckpointPath = `${this.paths.currentDir}/checkpoint-${iteration}.json`;
      await this.fs.writeJson(iterationCheckpointPath, result);
    }
  }
  async loadCheckpointResult() {
    const checkpointResultPath = `${this.paths.currentDir}/checkpoint-result.json`;
    if (!(await this.fs.exists(checkpointResultPath))) return null;
    try {
      const content = await this.fs.readFile(checkpointResultPath);
      return checkpointResultSchema.parse(JSON.parse(content));
    } catch {
      return null;
    }
  }
  async loadCheckpointResultForIteration(iteration) {
    const checkpointPath = `${this.paths.currentDir}/checkpoint-${iteration}.json`;
    if (!(await this.fs.exists(checkpointPath))) return null;
    try {
      const content = await this.fs.readFile(checkpointPath);
      return checkpointResultSchema.parse(JSON.parse(content));
    } catch {
      return null;
    }
  }
  async clearCheckpointResult() {
    const checkpointResultPath = `${this.paths.currentDir}/checkpoint-result.json`;
    if (await this.fs.exists(checkpointResultPath)) {
      await this.fs.unlink(checkpointResultPath);
    }
    if (await this.fs.exists(this.paths.currentDir)) {
      const files = await this.fs.readdir(this.paths.currentDir);
      for (const file of files) {
        if (file.match(/^checkpoint-\d+\.json$/)) {
          await this.fs.unlink(`${this.paths.currentDir}/${file}`);
        }
      }
    }
  }
  async backupSpec(runId) {
    const specContent = await this.fs.readFile(this.paths.spec);
    const backupPath = `${this.paths.baseDir}/spec-${runId}.md`;
    await this.fs.writeFile(backupPath, specContent);
    return backupPath;
  }
  async loadSpec() {
    return this.fs.readFile(this.paths.spec);
  }
  async saveSpec(content) {
    await this.fs.writeFile(this.paths.spec, content);
  }
  async readLearnings() {
    if (!(await this.fs.exists(this.paths.learnings))) return null;
    return this.fs.readFile(this.paths.learnings);
  }
  async appendMetricSample(runId, sample) {
    await this.fs.mkdir(this.paths.metricsDir);
    const filePath = this.paths.metricsFile(runId);
    const line =
      JSON.stringify(sample) +
      `
`;
    const { appendFile } = await import('fs/promises');
    await appendFile(filePath, line, 'utf-8');
  }
  async loadMetricSamples(runId) {
    const filePath = this.paths.metricsFile(runId);
    if (!(await this.fs.exists(filePath))) return [];
    const content = await this.fs.readFile(filePath);
    const samples = [];
    for (const line of content.split(`
`)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        samples.push(JSON.parse(trimmed));
      } catch {}
    }
    return samples;
  }
  async listMetricRuns() {
    if (!(await this.fs.exists(this.paths.metricsDir))) return [];
    const files = await this.fs.readdir(this.paths.metricsDir);
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''))
      .sort();
  }
  async archiveRun(checkpointRan = false) {
    const run = await this.loadRun();
    if (!run) throw new Error('No run to archive');
    const sessions = await this.loadSessions();
    const cfg = await this.loadConfig();
    const metricsSummary = await this.computeMetricsSummary(run.id);
    const entry = {
      id: run.id,
      spec: run.spec,
      config: cfg,
      status: run.status,
      iterations: run.iteration,
      startedAt: run.startedAt,
      completedAt: getCurrentTimestamp(),
      summary: await this.buildSummary(sessions, run.learnings),
      checkpointRan,
      metricsSummary,
    };
    await this.fs.writeJson(this.paths.historyEntry(run.id), entry);
    await this.clearCheckpointResult();
    await this.fs.rm(this.paths.currentDir, { recursive: true });
    return entry;
  }
  async computeMetricsSummary(runId) {
    const samples = await this.loadMetricSamples(runId);
    if (samples.length === 0) return;
    let totalDurationMs = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const s of samples) {
      totalDurationMs += s.durationMs;
      totalInputTokens += s.inputTokens ?? 0;
      totalOutputTokens += s.outputTokens ?? 0;
    }
    return { totalDurationMs, totalInputTokens, totalOutputTokens };
  }
  async buildSummary(sessions, learnings) {
    const byIteration = new Map();
    for (const s of sessions) {
      const list = byIteration.get(s.iteration) || [];
      list.push(s);
      byIteration.set(s.iteration, list);
    }
    const summaries = await Promise.all(
      Array.from(byIteration.entries()).map(async ([iteration, iterSessions]) => {
        const impl = iterSessions.find(s => s.role === 'implementer');
        const reviewers = iterSessions.filter(s => s.role === 'reviewer');
        let checkpointInfo = undefined;
        try {
          const checkpointPath = `${this.paths.currentDir}/checkpoint-${iteration}.json`;
          if (await this.fs.exists(checkpointPath)) {
            const content = await this.fs.readFile(checkpointPath);
            const result = checkpointResultSchema.parse(JSON.parse(content));
            checkpointInfo = {
              outcome: result.outcome,
              summary: result.summary,
              progressPercent: result.progressPercent,
            };
          }
        } catch {}
        return {
          iteration,
          implementerDuration:
            impl?.completedAt && impl?.startedAt
              ? new Date(impl.completedAt).getTime() - new Date(impl.startedAt).getTime()
              : 0,
          reviewerVerdicts: reviewers.map(r2 => ({
            index: r2.reviewerIndex ?? 0,
            verdict: r2.verdict ?? 'rejected',
            binary: r2.binary,
          })),
          learnings: learnings.filter((_3, i) => i < iteration),
          sessions: iterSessions.map(s => ({
            role: s.role,
            reviewerIndex: s.reviewerIndex,
          })),
          checkpointInfo,
        };
      }),
    );
    return summaries;
  }
  async listHistory() {
    if (!(await this.fs.exists(this.paths.historyDir))) return [];
    const files = await this.fs.readdir(this.paths.historyDir);
    const entries = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await this.fs.readFile(`${this.paths.historyDir}/${file}`);
        entries.push(parseHistoryEntry(JSON.parse(content)));
      } catch (err) {
        if (process.env.DEBUG) console.error(`Failed to parse history ${file}:`, err);
      }
    }
    return entries.sort((a, b3) => new Date(b3.startedAt).getTime() - new Date(a.startedAt).getTime());
  }
  async loadHistoryEntry(runId) {
    const entryPath = this.paths.historyEntry(runId);
    if (!(await this.fs.exists(entryPath))) return null;
    const content = await this.fs.readFile(entryPath);
    return parseHistoryEntry(JSON.parse(content));
  }
  async clearCurrentRun() {
    if (await this.fs.exists(this.paths.currentDir)) {
      await this.fs.rm(this.paths.currentDir, { recursive: true });
    }
  }
  async destroy() {
    await this.clearCurrentRun();
    if (await this.fs.exists(this.paths.config)) {
      await this.fs.unlink(this.paths.config);
    }
    if (await this.fs.exists(this.paths.spec)) {
      await this.fs.unlink(this.paths.spec);
    }
    if (await this.fs.exists(this.paths.historyDir)) {
      const historyFiles = await this.fs.readdir(this.paths.historyDir);
      if (historyFiles.length === 0) {
        await this.fs.rm(this.paths.historyDir, { recursive: true });
      }
    }
    if (await this.fs.exists(this.paths.baseDir)) {
      try {
        const remaining = await this.fs.readdir(this.paths.baseDir);
        if (remaining.length === 0) {
          await this.fs.rm(this.paths.baseDir, { recursive: true });
        }
      } catch {}
    }
  }
  async destroyAll() {
    if (await this.fs.exists(this.paths.baseDir)) {
      await this.fs.rm(this.paths.baseDir, { recursive: true });
    }
  }
}

// src/tmux/service.ts
import * as fs11 from 'fs/promises';
import * as path12 from 'path';
import * as os2 from 'os';
class TmuxServiceImpl {
  spawn;
  statusDir = path12.join(os2.tmpdir(), 'kloop', 'status');
  constructor(spawn = Bun.spawn.bind(Bun)) {
    this.spawn = spawn;
  }
  async isAvailable() {
    try {
      const proc = this.spawn(['tmux', '-V'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }
  async isSessionAlive(sessionName) {
    const cmd = buildHasSessionCommand(sessionName);
    const proc = this.spawn(cmd, {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }
  async listSessions() {
    const cmd = buildListSessionsCommand();
    const proc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return [];
    }
    const output = await new Response(proc.stdout).text();
    return output
      .split(
        `
`,
      )
      .map(s => s.trim())
      .filter(s => s.startsWith('kloop-') || s.startsWith('devloop-'));
  }
  async killSession(sessionName) {
    const cmd = buildKillSessionCommand(sessionName);
    const proc = this.spawn(cmd, {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  }
  async killAllSessions() {
    const sessions = await this.listSessions();
    let killed = 0;
    for (const session of sessions) {
      if (await this.killSession(session)) {
        killed++;
      }
    }
    return killed;
  }
  async runInSession(params) {
    await this.ensureStatusDir();
    const startTime = Date.now();
    const statusFile = this.getStatusFilePath(params.sessionName);
    try {
      await fs11.unlink(statusFile);
    } catch {}
    await fs11.writeFile(statusFile, 'RUNNING', { mode: 384 });
    const wrappedCommand = `${buildTimeoutCommand(params.command, params.timeoutMins)}; echo $? > "${statusFile}"`;
    const cmd = buildNewSessionCommand({
      sessionName: params.sessionName,
      cwd: params.cwd,
      command: wrappedCommand,
    });
    const { CLAUDECODE: _3, ...envWithoutClaudeCode } = process.env;
    const createProc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: envWithoutClaudeCode,
    });
    const createExitCode = await createProc.exited;
    if (createExitCode !== 0) {
      const stderr = await new Response(createProc.stderr).text();
      throw new Error(`Failed to create tmux session: ${stderr.trim() || `exit code ${createExitCode}`}`);
    }
    const maxPollTime = (params.timeoutMins + 2) * 60 * 1000;
    const pollStart = Date.now();
    while (true) {
      const alive = await this.isSessionAlive(params.sessionName);
      if (!alive) break;
      if (Date.now() - pollStart > maxPollTime) {
        await this.killSession(params.sessionName);
        break;
      }
      await Bun.sleep(2000);
    }
    const durationMs = Date.now() - startTime;
    let exitCode = 1;
    let timedOut = false;
    try {
      const statusContent = await fs11.readFile(statusFile, 'utf-8');
      const trimmed = statusContent.trim();
      if (trimmed === 'RUNNING') {
        exitCode = 1;
      } else {
        const parsed = parseInt(trimmed, 10);
        if (Number.isFinite(parsed)) {
          exitCode = parsed;
          timedOut = exitCode === 124;
        }
      }
    } catch {}
    try {
      await fs11.unlink(statusFile);
    } catch {}
    return { exitCode, durationMs, timedOut };
  }
  generateSessionName(params) {
    return generateSessionName(params);
  }
  parseSessionName(sessionName) {
    return parseSessionName(sessionName);
  }
  async ensureStatusDir() {
    await fs11.mkdir(this.statusDir, { recursive: true, mode: 448 });
  }
  getStatusFilePath(sessionName) {
    const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path12.join(this.statusDir, `${safeName}.status`);
  }
}
function createTmuxService(spawn) {
  return new TmuxServiceImpl(spawn);
}

// src/logs/service.ts
import * as path13 from 'path';

class LogsServiceImpl {
  fs;
  paths;
  constructor(fs12, paths2) {
    this.fs = fs12;
    this.paths = paths2;
  }
  async getCurrentRunId() {
    try {
      const content = await this.fs.readFile(this.paths.runJson);
      const run = JSON.parse(content);
      return run.id || null;
    } catch {
      return null;
    }
  }
  async listRuns() {
    const home = this.paths.kloopHome;
    if (!(await this.fs.exists(home))) {
      return [];
    }
    const entries = await this.fs.readdir(home);
    const runs = [];
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.endsWith('.lock') || entry === 'index.db') continue;
      const entryPath = path13.join(home, entry);
      try {
        const subEntries = await this.fs.readdir(entryPath);
        if (subEntries.some(f => f.startsWith('loop-'))) {
          runs.push(entry);
        }
      } catch {}
    }
    return runs.sort().reverse();
  }
  async listLogs(runId) {
    if (runId) {
      return this.listLogsForRun(runId);
    }
    const runs = await this.listRuns();
    const allLogs = [];
    for (const run of runs) {
      const logs = await this.listLogsForRun(run);
      allLogs.push(...logs);
    }
    return allLogs;
  }
  async listLogsByRun() {
    const runs = await this.listRuns();
    const result = [];
    for (const runId of runs) {
      const logs = await this.listLogsForRun(runId);
      if (logs.length > 0) {
        result.push({ runId, logs });
      }
    }
    return result;
  }
  async listLogsForRun(runId) {
    const runDir = this.paths.runPath(runId);
    if (!(await this.fs.exists(runDir))) {
      return [];
    }
    const entries = await this.fs.readdir(runDir);
    const logs = [];
    for (const entry of entries) {
      const loopMatch = entry.match(/^loop-(\d+)$/);
      if (!loopMatch) continue;
      const loopNum = parseInt(loopMatch[1], 10);
      const loopDir = path13.join(runDir, entry);
      try {
        const agentDirs = await this.fs.readdir(loopDir);
        for (const agentDir of agentDirs) {
          const logPath = path13.join(loopDir, agentDir, 'log');
          if (!(await this.fs.exists(logPath))) continue;
          const parsed = this.parseAgentDirName(agentDir, loopNum);
          if (parsed) {
            logs.push({
              runId,
              name: agentDir,
              path: logPath,
              ...parsed,
            });
          }
        }
      } catch {}
    }
    return logs.sort((a, b3) => {
      if (a.iteration !== b3.iteration) return a.iteration - b3.iteration;
      if (a.role !== b3.role) return a.role === 'impl' ? -1 : 1;
      return (a.reviewerIndex ?? 0) - (b3.reviewerIndex ?? 0);
    });
  }
  parseAgentDirName(name, loopNum) {
    if (name === 'implementer') {
      return { iteration: loopNum, role: 'impl' };
    }
    if (name === 'checkpointer') {
      return { iteration: loopNum, role: 'impl' };
    }
    const revMatch = name.match(/^reviewer-(\d+)$/);
    if (revMatch) {
      return {
        iteration: loopNum,
        role: 'rev',
        reviewerIndex: parseInt(revMatch[1], 10),
      };
    }
    return null;
  }
  async readLog(logPath) {
    return await this.fs.readFile(logPath);
  }
  parseLogName(name) {
    const implMatch = name.match(/^impl-(\d+)\.log$/);
    if (implMatch) {
      return {
        iteration: parseInt(implMatch[1], 10),
        role: 'impl',
      };
    }
    const revMatch = name.match(/^rev-(\d+)-(\d+)\.log$/);
    if (revMatch) {
      return {
        iteration: parseInt(revMatch[1], 10),
        role: 'rev',
        reviewerIndex: parseInt(revMatch[2], 10),
      };
    }
    return null;
  }
}
function createLogsService(fs12, paths2) {
  return new LogsServiceImpl(fs12, paths2);
}

// src/index.ts
var state = new StateService(defaultFsService, paths);
var tmux = createTmuxService();
var logs = createLogsService(defaultFsService, paths);
var indexDb = new IndexDb(defaultFsService, paths);
var eventLog = new EventLog(defaultFsService, paths);
var pidLock = new PidLock(defaultFsService, paths);
var program2 = createCli({ state, tmux, logs, indexDb, eventLog, pidLock });
program2.parse(process.argv);
