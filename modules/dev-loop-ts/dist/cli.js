#!/usr/bin/env bun
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to =
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, 'default', { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true,
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: newValue => (all[name] = () => newValue),
    });
};
var __esm = (fn, res) => () => (fn && (res = fn((fn = 0))), res);
var __require = import.meta.require;

// modules/dev-loop-ts/node_modules/commander/lib/error.js
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

// modules/dev-loop-ts/node_modules/commander/lib/argument.js
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

// modules/dev-loop-ts/node_modules/commander/lib/help.js
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

// modules/dev-loop-ts/node_modules/commander/lib/option.js
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

// modules/dev-loop-ts/node_modules/commander/lib/suggestSimilar.js
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

// modules/dev-loop-ts/node_modules/commander/lib/command.js
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

// modules/dev-loop-ts/node_modules/commander/index.js
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

// modules/dev-loop-ts/src/types.ts
function isValidVerdict(value) {
  return typeof value === 'string' && Object.values(VERDICT).includes(value);
}
function isValidRunStatus(value) {
  return typeof value === 'string' && Object.values(RUN_STATUS).includes(value);
}
function isValidPhase(value) {
  return typeof value === 'string' && Object.values(PHASE).includes(value);
}
function isValidAgentStatus(value) {
  return typeof value === 'string' && Object.values(AGENT_STATUS).includes(value);
}
function isValidAgentRole(value) {
  return typeof value === 'string' && Object.values(AGENT_ROLE).includes(value);
}
function getConfigValidationErrors(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    errors.push({ field: 'config', message: 'Config must be an object' });
    return errors;
  }
  const c = config;
  if (!c.claude || typeof c.claude !== 'string' || c.claude.trim().length === 0) {
    errors.push({ field: 'claude', message: 'Claude binary path is required' });
  }
  if (!Array.isArray(c.reviewers)) {
    errors.push({ field: 'reviewers', message: 'Reviewers must be an array' });
  } else if (c.reviewers.length === 0) {
    errors.push({ field: 'reviewers', message: 'At least one reviewer is required' });
  } else {
    const invalidReviewers = c.reviewers.filter(r => typeof r !== 'string' || r.trim().length === 0);
    if (invalidReviewers.length > 0) {
      errors.push({ field: 'reviewers', message: 'All reviewers must be non-empty strings' });
    }
  }
  const maxLoops = Number(c.maxLoops);
  if (!Number.isFinite(maxLoops) || maxLoops < 1 || maxLoops > 100) {
    errors.push({ field: 'maxLoops', message: 'maxLoops must be between 1 and 100' });
  }
  const timeoutMins = Number(c.timeoutMins);
  if (!Number.isFinite(timeoutMins) || timeoutMins < 1 || timeoutMins > 120) {
    errors.push({ field: 'timeoutMins', message: 'timeoutMins must be between 1 and 120' });
  }
  return errors;
}
function validateConfig(input) {
  const errors = getConfigValidationErrors(input);
  if (errors.length > 0) {
    const messages = errors.map(e => `  - ${e.field}: ${e.message}`).join(`
`);
    throw new Error(`Invalid configuration:
${messages}`);
  }
  const c = input;
  return {
    claude: c.claude.trim(),
    reviewers: c.reviewers.map(r => r.trim()).filter(r => r.length > 0),
    maxLoops: Number(c.maxLoops),
    timeoutMins: Number(c.timeoutMins),
  };
}
function validateRun(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Run must be an object');
  }
  const r = input;
  if (typeof r.id !== 'string' || r.id.length === 0) {
    throw new Error('Run must have a valid id');
  }
  if (typeof r.startTime !== 'string') {
    throw new Error('Run must have a startTime');
  }
  if (!isValidRunStatus(r.status)) {
    throw new Error(`Invalid run status: ${r.status}`);
  }
  if (!isValidPhase(r.phase)) {
    throw new Error(`Invalid phase: ${r.phase}`);
  }
  if (typeof r.loop !== 'number' || !Number.isFinite(r.loop) || r.loop < 0) {
    throw new Error('Run must have a valid loop number');
  }
  if (!Array.isArray(r.learnings)) {
    throw new Error('Run must have learnings array');
  }
  if (r.config) {
    validateConfig(r.config);
  }
  return r;
}
function validateAgentState(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('AgentState must be an object');
  }
  const a = input;
  if (typeof a.name !== 'string' || a.name.length === 0) {
    throw new Error('AgentState must have a name');
  }
  if (!isValidAgentRole(a.role)) {
    throw new Error(`Invalid agent role: ${a.role}`);
  }
  if (typeof a.iteration !== 'number' || !Number.isFinite(a.iteration)) {
    throw new Error('AgentState must have a valid iteration');
  }
  if (!isValidAgentStatus(a.status)) {
    throw new Error(`Invalid agent status: ${a.status}`);
  }
  if (a.verdict !== undefined && !isValidVerdict(a.verdict)) {
    throw new Error(`Invalid verdict: ${a.verdict}`);
  }
  return a;
}
function isRunning(run) {
  return run !== null && run.status === RUN_STATUS.RUNNING;
}
var VERDICT, RUN_STATUS, PHASE, AGENT_STATUS, AGENT_ROLE;
var init_types = __esm(() => {
  VERDICT = {
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    NO_VERDICT: 'NO_VERDICT',
    ERROR: 'ERROR',
  };
  RUN_STATUS = {
    RUNNING: 'running',
    COMPLETED: 'completed',
    MAX_LOOPS: 'max_loops',
    ERROR: 'error',
    CANCELLED: 'cancelled',
  };
  PHASE = {
    IMPLEMENTING: 'implementing',
    REVIEWING: 'reviewing',
    CHECKING: 'checking',
    DONE: 'done',
  };
  AGENT_STATUS = {
    NOT_STARTED: 'not_started',
    RUNNING: 'running',
    COMPLETED: 'completed',
    ERROR: 'error',
  };
  AGENT_ROLE = {
    IMPLEMENTER: 'implementer',
    REVIEWER: 'reviewer',
  };
});

// modules/dev-loop-ts/src/constants.ts
import * as os2 from 'os';
import * as path3 from 'path';
function checkBunVersion() {
  const version = Bun.version;
  const [major, minor, patch] = version.split('.').map(Number);
  const [reqMajor, reqMinor, reqPatch] = MIN_BUN_VERSION.split('.').map(Number);
  const current = major * 1e4 + minor * 100 + patch;
  const required = reqMajor * 1e4 + reqMinor * 100 + reqPatch;
  if (current < required) {
    throw new Error(
      `Bun version ${MIN_BUN_VERSION} or higher is required. ` +
        `Current version: ${version}. ` +
        `Update with: bun upgrade`,
    );
  }
}
function getTempDir() {
  const baseTemp = os2.tmpdir();
  const userSpecific = `dev-loop-${os2.userInfo().uid}`;
  return path3.join(baseTemp, userSpecific);
}
function getPromptFilePath(sessionId) {
  return path3.join(getTempDir(), 'prompts', `prompt-${sessionId}.txt`);
}
function sanitizeName(name) {
  return (
    name
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unnamed'
  );
}
function formatTime(isoString) {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}
function formatDateTime(isoString) {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
function getProjectHash() {
  const cwd = process.cwd();
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(cwd);
  const fullHash = hasher.digest('hex');
  const hashPrefix = fullHash.slice(0, 16);
  const suffix2 = cwd
    .split(path3.sep)
    .slice(-2)
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(0, 32);
  return `${hashPrefix}-${suffix2}`;
}
function generateRunId() {
  return crypto.randomUUID().slice(0, 8);
}
function getFinalVerdictIcon(verdict) {
  switch (verdict) {
    case 'approved':
      return '\u2705';
    case 'rejected':
      return '\u274C';
    case 'max_loops':
      return '\uD83D\uDD04';
    case 'cancelled':
      return '\uD83D\uDED1';
    case 'error':
      return '\u26A0\uFE0F';
    default:
      return '?';
  }
}
function getFinalVerdictText(verdict) {
  switch (verdict) {
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'max_loops':
      return 'Max Loops';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}
function getReviewerVerdictIcon(verdict) {
  switch (verdict) {
    case VERDICT.APPROVED:
      return '\u2705';
    case VERDICT.REJECTED:
      return '\u274C';
    case VERDICT.NO_VERDICT:
      return '\u26A0\uFE0F';
    case VERDICT.ERROR:
      return '\u274C';
    default:
      return '\u2753';
  }
}
function getAgentRoleIcon(role) {
  return role === 'implementer' ? '\uD83D\uDD28' : '\uD83D\uDD0D';
}
function getAgentRoleLabel(role) {
  return role === 'implementer' ? 'Implementer' : 'Reviewer';
}
var MIN_BUN_VERSION = '1.0.0',
  C,
  BASE_DIR = '.claude/dev-loop',
  CURRENT_DIR,
  PATHS,
  SPEC_TEMPLATE = `# Specification: [Title]

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
`,
  DEFAULT_CONFIG,
  MAX_HISTORY_ENTRIES = 100,
  MAX_SESSION_FILE_SIZE;
var init_constants = __esm(() => {
  init_types();
  C = {
    reset: '\x1B[0m',
    bold: '\x1B[1m',
    dim: '\x1B[2m',
    blue: '\x1B[34m',
    green: '\x1B[32m',
    yellow: '\x1B[33m',
    red: '\x1B[31m',
    magenta: '\x1B[35m',
    cyan: '\x1B[36m',
    white: '\x1B[37m',
  };
  CURRENT_DIR = `${BASE_DIR}/current`;
  PATHS = {
    baseDir: BASE_DIR,
    spec: `${BASE_DIR}/spec.md`,
    config: `${BASE_DIR}/config.json`,
    history: `${BASE_DIR}/history`,
    historyEntry: runId => `${BASE_DIR}/history/${runId}.json`,
    current: CURRENT_DIR,
    run: `${CURRENT_DIR}/run.json`,
    sessions: `${CURRENT_DIR}/sessions.json`,
    agents: `${CURRENT_DIR}/agents`,
    reviews: `${CURRENT_DIR}/reviews`,
    verdicts: `${CURRENT_DIR}/verdicts`,
    evidence: `${CURRENT_DIR}/evidence`,
    learnings: `${CURRENT_DIR}/learnings.md`,
    lock: `${CURRENT_DIR}/.lock`,
    agent: name => `${CURRENT_DIR}/agents/${sanitizeName(name)}.json`,
    review: name => `${CURRENT_DIR}/reviews/${sanitizeName(name)}.md`,
    verdict: name => `${CURRENT_DIR}/verdicts/${sanitizeName(name)}.txt`,
  };
  DEFAULT_CONFIG = {
    claude: 'claude',
    reviewers: ['claude-reviewer-zai'],
    maxLoops: 20,
    timeoutMins: 20,
  };
  MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;
});

// modules/dev-loop-ts/src/history.ts
var exports_history = {};
__export(exports_history, {
  showHistoryEntry: () => showHistoryEntry,
  showHistory: () => showHistory,
  loadHistoryEntry: () => loadHistoryEntry,
  listHistory: () => listHistory,
  clearHistory: () => clearHistory,
  archiveRun: () => archiveRun,
});
import * as fs3 from 'fs/promises';
import * as path4 from 'path';
async function readVerdictFile(reviewerName) {
  try {
    const verdictFile = PATHS.verdict(reviewerName);
    const file = Bun.file(verdictFile);
    if (!(await file.exists())) {
      return VERDICT.NO_VERDICT;
    }
    const content = (await file.text()).trim().toUpperCase();
    if (content === 'APPROVED') return VERDICT.APPROVED;
    if (content === 'REJECTED') return VERDICT.REJECTED;
    return VERDICT.NO_VERDICT;
  } catch {
    return VERDICT.NO_VERDICT;
  }
}
async function archiveRun(run, sessions) {
  await fs3.mkdir(PATHS.history, { recursive: true });
  const iterationMap = new Map();
  for (const session of sessions) {
    const existing = iterationMap.get(session.iteration);
    if (existing) {
      existing.push(session);
    } else {
      iterationMap.set(session.iteration, [session]);
    }
  }
  const iterations = [];
  for (const [iteration, iterSessions] of iterationMap) {
    const impl = iterSessions.find(s => s.role === 'implementer');
    const reviewers = iterSessions.filter(s => s.role === 'reviewer');
    const learning = run.learnings.find(l => l.iteration === iteration);
    const reviewerResults = await Promise.all(
      reviewers.map(async r => ({
        name: r.name,
        sessionId: r.sessionId,
        verdict: iteration === run.loop ? await readVerdictFile(r.name) : VERDICT.NO_VERDICT,
      })),
    );
    iterations.push({
      iteration,
      implementer: {
        name: impl?.name || 'unknown',
        sessionId: impl?.sessionId || '',
      },
      reviewers: reviewerResults,
      learnings: learning?.content,
    });
  }
  let finalVerdict;
  switch (run.status) {
    case RUN_STATUS.COMPLETED:
      finalVerdict = 'approved';
      break;
    case RUN_STATUS.MAX_LOOPS:
      finalVerdict = 'max_loops';
      break;
    case RUN_STATUS.CANCELLED:
      finalVerdict = 'cancelled';
      break;
    case RUN_STATUS.ERROR:
      finalVerdict = 'error';
      break;
    default:
      finalVerdict = 'error';
  }
  const entry = {
    id: run.id,
    startTime: run.startTime,
    endTime: run.endTime || new Date().toISOString(),
    status: run.status,
    totalIterations: run.loop,
    config: run.config,
    iterations,
    finalVerdict,
  };
  await Bun.write(PATHS.historyEntry(run.id), JSON.stringify(entry, null, 2));
  await pruneHistory();
  return run.id;
}
async function pruneHistory() {
  const entries = await listHistory();
  if (entries.length <= MAX_HISTORY_ENTRIES) return;
  const toDelete = entries.slice(MAX_HISTORY_ENTRIES);
  for (const entry of toDelete) {
    try {
      await fs3.unlink(PATHS.historyEntry(entry.id));
    } catch {}
  }
}
async function listHistory() {
  const entries = [];
  try {
    const files = await fs3.readdir(PATHS.history);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    for (const file of jsonFiles) {
      try {
        const filePath = path4.join(PATHS.history, file);
        const entry = await Bun.file(filePath).json();
        entries.push(entry);
      } catch (err) {
        console.error(`Warning: Skipping invalid history file ${file}:`, err.message);
      }
    }
  } catch {
    return [];
  }
  entries.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return entries;
}
async function loadHistoryEntry(runId) {
  const file = Bun.file(PATHS.historyEntry(runId));
  if (!(await file.exists())) return null;
  return file.json();
}
async function showHistory() {
  const entries = await listHistory();
  if (entries.length === 0) {
    console.log('\u2139\uFE0F No run history found.');
    return;
  }
  console.log(`${C.bold}\uD83D\uDCDC Dev Loop History${C.reset}
`);
  for (const entry of entries) {
    const startDate = formatDateTime(entry.startTime);
    const duration = entry.endTime
      ? formatDuration(new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime())
      : 'ongoing';
    console.log(
      `${getFinalVerdictIcon(entry.finalVerdict)} ${C.bold}${entry.id}${C.reset} - ${getFinalVerdictText(entry.finalVerdict)}`,
    );
    console.log(`   ${C.dim}Started: ${startDate}${C.reset}`);
    console.log(`   ${C.dim}Duration: ${duration} | Iterations: ${entry.totalIterations}${C.reset}`);
    console.log(`   ${C.dim}Reviewers: ${entry.config.reviewers.join(', ')}${C.reset}`);
    console.log('');
  }
  console.log(`${C.dim}Use 'dev-loop history <run-id>' for details${C.reset}`);
}
async function showHistoryEntry(runId) {
  const entry = await loadHistoryEntry(runId);
  if (!entry) {
    throw new Error(`Run ${runId} not found in history`);
  }
  const duration = formatDuration(new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime());
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log(`${C.bold}${C.magenta}\uD83D\uDCDC Run: ${entry.id}${C.reset}`);
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log('');
  console.log(
    `${C.bold}Result:${C.reset} ${getFinalVerdictIcon(entry.finalVerdict)} ${getFinalVerdictText(entry.finalVerdict)}`,
  );
  console.log(`${C.bold}Started:${C.reset} ${formatDateTime(entry.startTime)}`);
  console.log(`${C.bold}Ended:${C.reset} ${formatDateTime(entry.endTime)}`);
  console.log(`${C.bold}Duration:${C.reset} ${duration}`);
  console.log(`${C.bold}Iterations:${C.reset} ${entry.totalIterations}`);
  console.log('');
  console.log(`${C.bold}Config:${C.reset}`);
  console.log(`  Claude: ${entry.config.claude}`);
  console.log(`  Reviewers: ${entry.config.reviewers.join(', ')}`);
  console.log(`  Max loops: ${entry.config.maxLoops}`);
  console.log(`  Timeout: ${entry.config.timeoutMins}m`);
  console.log('');
  if (entry.iterations.length > 0) {
    console.log(`${C.bold}Iterations:${C.reset}`);
    for (const iter of entry.iterations) {
      console.log(`
  ${C.cyan}\u2500\u2500 Iteration ${iter.iteration} \u2500\u2500${C.reset}`);
      console.log(`  \uD83D\uDD28 Implementer: ${iter.implementer.name}`);
      for (const r of iter.reviewers) {
        const icon = getReviewerVerdictIcon(r.verdict);
        console.log(`  \uD83D\uDD0D ${r.name}: ${icon} ${r.verdict}`);
      }
      if (iter.learnings) {
        console.log(
          `  \uD83D\uDCDD Learnings: ${iter.learnings
            .split(
              `
`,
            )[0]
            .slice(0, 50)}...`,
        );
      }
    }
  }
}
async function clearHistory() {
  if (!PATHS.history.startsWith('.claude/')) {
    throw new Error('Refusing to delete outside .claude directory');
  }
  try {
    const files = await fs3.readdir(PATHS.history);
    for (const file of files) {
      if (file.endsWith('.json')) {
        await fs3.unlink(path4.join(PATHS.history, file));
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}
var init_history = __esm(() => {
  init_types();
  init_constants();
});

// modules/dev-loop-ts/node_modules/commander/esm.mjs
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

// modules/dev-loop-ts/node_modules/bun-promptx/dist/index.mjs
import { ptr } from 'bun:ffi';
import { dlopen, FFIType, suffix } from 'bun:ffi';
import { CString } from 'bun:ffi';
var { platform, arch } = process;
var filename;
if (arch === 'x64') {
  filename = `../release/promptx-${platform}-amd64.${suffix}`;
} else {
  filename = `../release/promptx-${platform}-${arch}.${suffix}`;
}
var location = new URL(filename, import.meta.url).pathname;
var { symbols } = dlopen(location, {
  CreateSelection: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.int],
    returns: FFIType.ptr,
  },
  CreatePrompt: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool, FFIType.int],
    returns: FFIType.ptr,
  },
  FreeString: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
});
var utf8e = new TextEncoder();
function encode(data) {
  return utf8e.encode(data + '\x00');
}
function toString(ptr3) {
  const str = new CString(ptr3);
  symbols.FreeString(str.ptr);
  return str.toString();
}
function createSelection(items, options = {}) {
  const stringifiedItems = JSON.stringify(
    items.map(item => {
      return {
        text: item.text,
        description: item.description || '',
      };
    }),
  );
  const returnedPtr = symbols.CreateSelection(
    ptr(encode(stringifiedItems)),
    ptr(encode(options.headerText || 'Select an item: ')),
    ptr(encode(options.footerText || '')),
    options.perPage || 5,
  );
  const { selectedIndex, error } = JSON.parse(toString(returnedPtr));
  if (error !== '') {
    return {
      selectedIndex: null,
      error,
    };
  }
  return {
    selectedIndex: Number(selectedIndex),
    error: null,
  };
}

// modules/dev-loop-ts/src/state.ts
import * as path5 from 'path';
import * as fs4 from 'fs/promises';

// modules/dev-loop-ts/src/lock.ts
import * as fs from 'fs/promises';
import * as path from 'path';
var LOCK_TIMEOUT_MS = 30000;
var LOCK_RETRY_MS = 100;
var LOCK_STALE_MS = 60000;
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function createLockInfo() {
  return {
    pid: process.pid,
    timestamp: Date.now(),
    hostname: __require('os').hostname(),
  };
}
function parseLockInfo(content) {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.pid === 'number' && typeof parsed.timestamp === 'number' && typeof parsed.hostname === 'string') {
      return parsed;
    }
    return null;
  } catch {
    const lines = content.trim().split(`
`);
    const pid = parseInt(lines[0] || '0', 10);
    const timestamp = parseInt(lines[1] || '0', 10);
    if (pid > 0 && timestamp > 0) {
      return { pid, timestamp, hostname: 'unknown' };
    }
    return null;
  }
}
async function tryAcquireLockAtomic(lockFile) {
  const lockInfo = createLockInfo();
  const lockContent = JSON.stringify(lockInfo);
  try {
    await fs.writeFile(lockFile, lockContent, { flag: 'wx', mode: 384 });
    return true;
  } catch (err) {
    const code = err.code;
    if (code === 'EEXIST') {
      return false;
    }
    if (code === 'ENOENT') {
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      try {
        await fs.writeFile(lockFile, lockContent, { flag: 'wx', mode: 384 });
        return true;
      } catch {
        return false;
      }
    }
    throw err;
  }
}
async function isLockStale(lockFile) {
  try {
    const content = await fs.readFile(lockFile, 'utf-8');
    const lockInfo = parseLockInfo(content);
    if (!lockInfo) {
      return true;
    }
    const lockAge = Date.now() - lockInfo.timestamp;
    if (lockInfo.pid > 0 && !isPidAlive(lockInfo.pid)) {
      return true;
    }
    if (lockAge > LOCK_STALE_MS) {
      return true;
    }
    return false;
  } catch (err) {
    const code = err.code;
    if (code === 'ENOENT') {
      return false;
    }
    return true;
  }
}
async function acquireLock(lockFile) {
  const startTime = Date.now();
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  while (true) {
    if (await tryAcquireLockAtomic(lockFile)) {
      return;
    }
    if (await isLockStale(lockFile)) {
      try {
        await fs.unlink(lockFile);
        continue;
      } catch {
        continue;
      }
    }
    if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
      let holderInfo = 'unknown';
      try {
        const content = await fs.readFile(lockFile, 'utf-8');
        const lockInfo = parseLockInfo(content);
        if (lockInfo) {
          holderInfo = `PID ${lockInfo.pid} on ${lockInfo.hostname}`;
        }
      } catch {}
      throw new Error(`Timeout waiting for state lock (held by ${holderInfo})`);
    }
    await Bun.sleep(LOCK_RETRY_MS);
  }
}
async function releaseLock(lockFile) {
  try {
    const content = await fs.readFile(lockFile, 'utf-8');
    const lockInfo = parseLockInfo(content);
    if (lockInfo && lockInfo.pid === process.pid) {
      await fs.unlink(lockFile);
    }
  } catch (err) {
    const code = err.code;
    if (code === 'ENOENT') {
      return;
    }
    console.error(`Warning: Failed to release lock: ${err.message}`);
  }
}
async function withLock(lockFile, fn) {
  await acquireLock(lockFile);
  try {
    return await fn();
  } finally {
    await releaseLock(lockFile);
  }
}

// modules/dev-loop-ts/src/tmux.ts
import * as fs2 from 'fs/promises';
import * as path2 from 'path';
import * as os from 'os';
var DEV_LOOP_SESSION_PREFIX = 'dev-loop-';
async function checkTmuxAvailable() {
  const tmuxPath = Bun.which('tmux');
  if (!tmuxPath) {
    throw new Error(
      `tmux is not installed or not in PATH.
` + 'Install it with: brew install tmux (macOS) or apt install tmux (Linux)',
    );
  }
}
async function isSessionAlive(sessionName) {
  const proc = Bun.spawn(['tmux', 'has-session', '-t', sessionName], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
async function listDevLoopSessions() {
  const proc = Bun.spawn(['tmux', 'ls', '-F', '#{session_name}'], {
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
    .filter(s => s.startsWith(DEV_LOOP_SESSION_PREFIX));
}
async function killSession(sessionName) {
  const proc = Bun.spawn(['tmux', 'kill-session', '-t', sessionName], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
async function killAllDevLoopSessions() {
  const sessions = await listDevLoopSessions();
  let killed = 0;
  for (const session of sessions) {
    if (await killSession(session)) {
      killed++;
    }
  }
  return killed;
}
var STATUS_DIR = path2.join(os.tmpdir(), 'dev-loop', 'status');
async function ensureStatusDir() {
  await fs2.mkdir(STATUS_DIR, { recursive: true, mode: 448 });
}
function getStatusFilePath(sessionName) {
  const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path2.join(STATUS_DIR, `${safeName}.status`);
}
async function runInSession(sessionName, command, cwd, timeoutMins, pollIntervalMs = 2000) {
  await checkTmuxAvailable();
  await ensureStatusDir();
  const startTime = Date.now();
  const statusFile = getStatusFilePath(sessionName);
  try {
    await fs2.unlink(statusFile);
  } catch {}
  await fs2.writeFile(statusFile, 'RUNNING', { mode: 384 });
  const wrappedCommand = `timeout ${timeoutMins}m ${command}; echo $? > "${statusFile}"`;
  const createProc = Bun.spawn(
    ['tmux', 'new-session', '-d', '-s', sessionName, '-c', cwd, 'sh', '-c', wrappedCommand],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const createExitCode = await createProc.exited;
  if (createExitCode !== 0) {
    const stderr = await new Response(createProc.stderr).text();
    throw new Error(
      `Failed to create tmux session '${sessionName}': ${stderr.trim() || `exit code ${createExitCode}`}`,
    );
  }
  const maxPollTime = (timeoutMins + 2) * 60 * 1000;
  const pollStart = Date.now();
  while (true) {
    const alive = await isSessionAlive(sessionName);
    if (!alive) break;
    if (Date.now() - pollStart > maxPollTime) {
      console.warn(`Polling timeout exceeded for ${sessionName}, killing session`);
      await killSession(sessionName);
      break;
    }
    await Bun.sleep(pollIntervalMs);
  }
  const durationMs = Date.now() - startTime;
  let exitCode = 1;
  let timedOut = false;
  try {
    const statusContent = await fs2.readFile(statusFile, 'utf-8');
    const trimmed = statusContent.trim();
    if (trimmed === 'RUNNING') {
      console.warn(`Session ${sessionName} terminated without exit code`);
      exitCode = 1;
    } else {
      const parsed = parseInt(trimmed, 10);
      if (Number.isFinite(parsed)) {
        exitCode = parsed;
        timedOut = exitCode === 124;
      }
    }
  } catch (err) {
    const code = err.code;
    if (code !== 'ENOENT') {
      console.warn(`Could not read status file for ${sessionName}: ${err.message}`);
    }
  }
  try {
    await fs2.unlink(statusFile);
  } catch {}
  return { exitCode, durationMs, timedOut };
}
function generateSessionName(role, agentName, iteration, uniqueId) {
  const safeName = agentName
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const shortId = uniqueId.slice(0, 8);
  return `${DEV_LOOP_SESSION_PREFIX}${role}-${safeName}-${iteration}-${shortId}`;
}
function parseSessionName(sessionName) {
  if (!sessionName.startsWith(DEV_LOOP_SESSION_PREFIX)) {
    return null;
  }
  const withoutPrefix = sessionName.slice(DEV_LOOP_SESSION_PREFIX.length);
  const parts = withoutPrefix.split('-');
  if (parts.length < 4) {
    return null;
  }
  const role = parts[0];
  if (role !== 'impl' && role !== 'review') {
    return null;
  }
  const uniqueId = parts[parts.length - 1];
  const iteration = parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(iteration) || iteration < 1) {
    return null;
  }
  const agentName = parts.slice(1, -2).join('-');
  return { role, agentName, iteration, uniqueId };
}
async function cleanupStaleStatusFiles() {
  let cleaned = 0;
  try {
    await ensureStatusDir();
    const files = await fs2.readdir(STATUS_DIR);
    for (const file of files) {
      if (!file.endsWith('.status')) continue;
      try {
        const filePath = path2.join(STATUS_DIR, file);
        const stat2 = await fs2.stat(filePath);
        if (Date.now() - stat2.mtimeMs > 60 * 60 * 1000) {
          await fs2.unlink(filePath);
          cleaned++;
        }
      } catch {}
    }
  } catch {}
  return cleaned;
}

// modules/dev-loop-ts/src/state.ts
init_types();
init_constants();
var CONFIG_VERSION = 1;
async function withStateLock(fn) {
  return withLock(PATHS.lock, fn);
}
async function ensureDir(dirPath) {
  await fs4.mkdir(dirPath, { recursive: true });
}
async function safeReadJson(filePath) {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return null;
    }
    return await file.json();
  } catch (err) {
    console.error(`Warning: Failed to read ${filePath}: ${err.message}`);
    return null;
  }
}
async function safeWriteJson(filePath, data) {
  await ensureDir(path5.dirname(filePath));
  await Bun.write(filePath, JSON.stringify(data, null, 2));
}
function migrateConfig(config) {
  const version = config._version ?? 0;
  const migrated = { ...config };
  if (version < 1) {
    if (!migrated.claude) migrated.claude = DEFAULT_CONFIG.claude;
    if (!Array.isArray(migrated.reviewers) || migrated.reviewers.length === 0) {
      migrated.reviewers = [...DEFAULT_CONFIG.reviewers];
    }
    if (!Number.isFinite(migrated.maxLoops) || migrated.maxLoops < 1) {
      migrated.maxLoops = DEFAULT_CONFIG.maxLoops;
    }
    if (!Number.isFinite(migrated.timeoutMins) || migrated.timeoutMins < 1) {
      migrated.timeoutMins = DEFAULT_CONFIG.timeoutMins;
    }
  }
  delete migrated._version;
  return migrated;
}
async function initProject(overrides) {
  await ensureDir(PATHS.baseDir);
  await ensureDir(PATHS.history);
  const specFile = Bun.file(PATHS.spec);
  if (!(await specFile.exists())) {
    await Bun.write(PATHS.spec, SPEC_TEMPLATE);
  }
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    ...overrides,
  });
  await saveConfig(config);
  await ensureGitIgnore();
}
async function loadConfig() {
  const file = Bun.file(PATHS.config);
  if (!(await file.exists())) {
    throw new Error('No dev-loop initialized. Run: dev-loop init');
  }
  const rawConfig = await file.json();
  const config = migrateConfig(rawConfig);
  if (rawConfig._version !== CONFIG_VERSION) {
    await saveConfig(config);
  }
  return config;
}
async function saveConfig(config) {
  const versionedConfig = {
    ...config,
    _version: CONFIG_VERSION,
  };
  await Bun.write(PATHS.config, JSON.stringify(versionedConfig, null, 2));
}
async function updateConfig(updates) {
  const config = await loadConfig();
  const updated = validateConfig({ ...config, ...updates });
  await saveConfig(updated);
  return updated;
}
async function ensureGitIgnore() {
  const gitignoreFile = '.gitignore';
  const entry = '.claude/dev-loop';
  try {
    const file = Bun.file(gitignoreFile);
    let content = '';
    if (await file.exists()) {
      content = await file.text();
    }
    const hasEntry = content
      .split(
        `
`,
      )
      .some(line => line.trim() === entry || line.trim() === entry + '/');
    if (!hasEntry) {
      if (
        content &&
        !content.endsWith(`
`)
      ) {
        content += `
`;
      }
      content += `${entry}/
`;
      await Bun.write(gitignoreFile, content);
      console.log(`Added '${entry}/' to .gitignore`);
    }
  } catch (err) {
    console.warn(`Warning: Could not update .gitignore: ${err.message}`);
  }
}
async function loadRun() {
  const data = await safeReadJson(PATHS.run);
  if (!data) return null;
  try {
    return validateRun(data);
  } catch (err) {
    console.error(`Warning: Invalid run state: ${err.message}`);
    return null;
  }
}
async function createRun(config) {
  const existing = await loadRun();
  if (isRunning(existing)) {
    throw new Error(`Run ${existing.id} is already in progress. Use: dev-loop cancel`);
  }
  if (existing) {
    await archiveCurrentRun();
  }
  await ensureDir(PATHS.agents);
  await ensureDir(PATHS.reviews);
  await ensureDir(PATHS.verdicts);
  await ensureDir(PATHS.evidence);
  const run = {
    id: generateRunId(),
    startTime: new Date().toISOString(),
    status: RUN_STATUS.RUNNING,
    phase: PHASE.IMPLEMENTING,
    loop: 0,
    learnings: [],
    config,
  };
  await safeWriteJson(PATHS.run, run);
  await safeWriteJson(PATHS.sessions, []);
  return run;
}
async function saveRun(run) {
  await safeWriteJson(PATHS.run, run);
}
async function updateRun(updates) {
  return withStateLock(async () => {
    const run = await loadRun();
    if (!run) {
      throw new Error('No active run');
    }
    Object.assign(run, updates);
    await saveRun(run);
    return run;
  });
}
async function setPhase(phase) {
  await updateRun({ phase });
}
async function incrementLoop() {
  return withStateLock(async () => {
    const run = await loadRun();
    if (!run) throw new Error('No active run');
    run.loop += 1;
    await saveRun(run);
    return run.loop;
  });
}
async function addLearning(content) {
  await withStateLock(async () => {
    const run = await loadRun();
    if (!run) throw new Error('No active run');
    const learning = { iteration: run.loop, content };
    run.learnings.push(learning);
    await saveRun(run);
  });
}
async function completeRun(status) {
  await updateRun({
    status,
    phase: PHASE.DONE,
    endTime: new Date().toISOString(),
  });
  await archiveCurrentRun();
}
async function getAgentState(name) {
  const safeName = sanitizeName(name);
  const data = await safeReadJson(PATHS.agent(safeName));
  if (!data) return null;
  try {
    return validateAgentState(data);
  } catch (err) {
    console.error(`Warning: Invalid agent state for ${name}: ${err.message}`);
    return null;
  }
}
async function saveAgentState(agent) {
  await ensureDir(PATHS.agents);
  const safeName = sanitizeName(agent.name);
  await safeWriteJson(PATHS.agent(safeName), agent);
}
async function getAllAgentStates() {
  const agents = [];
  try {
    const files = await fs4.readdir(PATHS.agents);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    for (const file of jsonFiles) {
      try {
        const filePath = path5.join(PATHS.agents, file);
        const data = await Bun.file(filePath).json();
        const agent = validateAgentState(data);
        agents.push(agent);
      } catch (err) {
        console.error(`Warning: Skipping invalid agent file ${file}: ${err.message}`);
      }
    }
  } catch {
    return [];
  }
  return agents;
}
async function initAgentStates(iteration, implementer, reviewers) {
  await ensureDir(PATHS.agents);
  const implName = sanitizeName(path5.basename(implementer));
  await saveAgentState({
    name: implName,
    role: AGENT_ROLE.IMPLEMENTER,
    iteration,
    status: AGENT_STATUS.NOT_STARTED,
  });
  for (const reviewer of reviewers) {
    const name = sanitizeName(path5.basename(reviewer));
    await saveAgentState({
      name,
      role: AGENT_ROLE.REVIEWER,
      iteration,
      status: AGENT_STATUS.NOT_STARTED,
    });
  }
}
async function updateAgentState(name, updates) {
  const safeName = sanitizeName(name);
  return withStateLock(async () => {
    const existing = await getAgentState(safeName);
    if (existing) {
      await saveAgentState({ ...existing, ...updates });
    } else {
      await saveAgentState({
        name: safeName,
        role: updates.role || AGENT_ROLE.REVIEWER,
        iteration: updates.iteration || 0,
        status: updates.status || AGENT_STATUS.NOT_STARTED,
        ...updates,
      });
    }
  });
}
async function setAgentRunning(name, sessionId, tmuxSession) {
  await updateAgentState(name, {
    status: AGENT_STATUS.RUNNING,
    sessionId,
    tmuxSession,
    startTime: new Date().toISOString(),
  });
}
async function setAgentCompleted(name, verdict) {
  await updateAgentState(name, {
    status: AGENT_STATUS.COMPLETED,
    endTime: new Date().toISOString(),
    ...(verdict && { verdict }),
  });
}
async function setAgentError(name) {
  await updateAgentState(name, {
    status: AGENT_STATUS.ERROR,
    endTime: new Date().toISOString(),
  });
}
async function clearEvidence() {
  if (!PATHS.evidence.startsWith('.claude/')) {
    throw new Error('Refusing to delete outside .claude directory');
  }
  try {
    const files = await fs4.readdir(PATHS.evidence);
    for (const file of files) {
      await fs4.unlink(path5.join(PATHS.evidence, file));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  await ensureDir(PATHS.evidence);
}
async function clearReviews() {
  try {
    const reviewFiles = await fs4.readdir(PATHS.reviews);
    for (const file of reviewFiles) {
      if (file.endsWith('.md')) {
        await fs4.unlink(path5.join(PATHS.reviews, file));
      }
    }
  } catch {}
  try {
    const verdictFiles = await fs4.readdir(PATHS.verdicts);
    for (const file of verdictFiles) {
      if (file.endsWith('.txt')) {
        await fs4.unlink(path5.join(PATHS.verdicts, file));
      }
    }
  } catch {}
  try {
    await fs4.unlink(PATHS.learnings);
  } catch {}
}
async function recordSession(session) {
  await withStateLock(async () => {
    const file = Bun.file(PATHS.sessions);
    const sessions = (await file.exists()) ? await file.json() : [];
    sessions.push(session);
    await safeWriteJson(PATHS.sessions, sessions);
  });
}
async function getSessions(iteration) {
  const data = await safeReadJson(PATHS.sessions);
  if (!data || !Array.isArray(data)) return [];
  return iteration !== undefined ? data.filter(s => s.iteration === iteration) : data;
}
async function readVerdict(reviewer) {
  const safeName = sanitizeName(reviewer);
  const file = Bun.file(PATHS.verdict(safeName));
  if (!(await file.exists())) return null;
  return (await file.text()).trim();
}
async function readLearnings() {
  const file = Bun.file(PATHS.learnings);
  if (!(await file.exists())) return null;
  return file.text();
}
async function isTmuxSessionAlive(sessionName) {
  return isSessionAlive(sessionName);
}
async function listAgentSessions() {
  return listDevLoopSessions();
}
async function killAgentSessions() {
  await killAllDevLoopSessions();
}
async function archiveCurrentRun() {
  const run = await loadRun();
  if (!run) return null;
  const sessions = await getSessions();
  const history = await Promise.resolve().then(() => (init_history(), exports_history));
  const runId = await history.archiveRun(run, sessions);
  try {
    await fs4.rm(PATHS.current, { recursive: true, force: true });
  } catch {}
  return runId;
}
async function cancelRun() {
  await killAgentSessions();
  const run = await loadRun();
  if (run) {
    run.status = RUN_STATUS.CANCELLED;
    run.endTime = new Date().toISOString();
    await saveRun(run);
    await archiveCurrentRun();
  }
}
async function destroyAll() {
  if (!PATHS.baseDir.startsWith('.claude/')) {
    throw new Error('Refusing to delete outside .claude directory');
  }
  await killAgentSessions();
  try {
    await fs4.rm(PATHS.baseDir, { recursive: true, force: true });
  } catch {}
}

// modules/dev-loop-ts/src/agents.ts
import * as os3 from 'os';
import * as path6 from 'path';
import * as fs5 from 'fs/promises';
init_types();
init_constants();
async function validateBinary(binary) {
  if (!binary || typeof binary !== 'string') {
    throw new Error('Binary name must be a non-empty string');
  }
  const resolvedPath = Bun.which(binary);
  if (!resolvedPath) {
    throw new Error(
      `Binary not found: '${binary}'
` + `Make sure it's installed and in your PATH.`,
    );
  }
  try {
    const stat3 = await fs5.stat(resolvedPath);
    if (!stat3.isFile()) {
      throw new Error(`Binary path is not a file: ${resolvedPath}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Binary not found at resolved path: ${resolvedPath}`);
    }
    throw err;
  }
  return resolvedPath;
}
function getConfigDirFromBinary(binary) {
  const name = path6.basename(binary);
  const configDir = name === 'claude' ? '.claude' : `.${sanitizeName(name)}`;
  return path6.join(os3.homedir(), configDir);
}
async function ensurePromptDir() {
  const promptDir = path6.join(getTempDir(), 'prompts');
  await fs5.mkdir(promptDir, { recursive: true, mode: 448 });
}
async function writePromptFile(prompt, sessionId) {
  await ensurePromptDir();
  const promptFile = getPromptFilePath(sessionId);
  await fs5.writeFile(promptFile, prompt, { mode: 384 });
  return promptFile;
}
async function cleanupPromptFile(promptFile) {
  try {
    await fs5.unlink(promptFile);
  } catch {}
}
async function cleanupStalePromptFiles() {
  let cleaned = 0;
  const promptDir = path6.join(getTempDir(), 'prompts');
  try {
    const files = await fs5.readdir(promptDir);
    for (const file of files) {
      if (!file.startsWith('prompt-') || !file.endsWith('.txt')) continue;
      try {
        const filePath = path6.join(promptDir, file);
        const stat3 = await fs5.stat(filePath);
        if (Date.now() - stat3.mtimeMs > 60 * 60 * 1000) {
          await fs5.unlink(filePath);
          cleaned++;
        }
      } catch {}
    }
  } catch {}
  await cleanupStaleStatusFiles();
  return cleaned;
}
function buildImplementerPrompt(iteration, learnings) {
  const evidenceDir = PATHS.evidence;
  if (iteration === 1) {
    return `You are the IMPLEMENTER for iteration 1 (first iteration).

READ FIRST:
- Spec: ${PATHS.spec}

TASK:
1. Implement the spec requirements
2. Do NOT modify the spec
3. Do NOT commit changes

EVIDENCE OF COMPLETION:
When your implementation is complete, you MUST provide evidence:
- Build output showing successful compilation/build
- Test output showing passing tests
- Screenshots or terminal output demonstrating the feature works
- Save all evidence to files in ${evidenceDir}/
  - build-output.log or build-output.txt: Build/command output
  - test-output.log or test-output.txt: Test results
  - evidence.md: Summary of what was done and proof it works

Example evidence commands:
- For TypeScript: bun run build > ${evidenceDir}/build-output.log 2>&1
- For tests: bun test > ${evidenceDir}/test-output.log 2>&1
- For demo: echo "Demo output" > ${evidenceDir}/evidence.md

Be concise and focused.`;
  }
  const learningsText =
    learnings.length > 0
      ? learnings.map(l => `- Iteration ${l.iteration}: ${l.content}`).join(`
`)
      : 'None yet';
  return `You are the IMPLEMENTER for iteration ${iteration}.

READ FIRST (in order):
1. Spec: ${PATHS.spec}
2. Review feedback: ${PATHS.reviews}/*.md (IMPORTANT - address ALL issues raised)

PREVIOUS LEARNINGS:
${learningsText}

TASKS:
1. Read and understand ALL review feedback carefully
2. Address EVERY issue raised by reviewers
3. Implement fixes and improvements
4. Write learnings to ${PATHS.learnings} (1-3 bullet points)

EVIDENCE OF COMPLETION:
You MUST provide proof that your fixes work:
- Build output: ${evidenceDir}/build-output.log
- Test output: ${evidenceDir}/test-output.log
- Summary: ${evidenceDir}/evidence.md

Do NOT modify the spec. Do NOT commit changes. Be concise.`;
}
function buildReviewerPrompt(reviewerName, iteration) {
  const reviewFile = PATHS.review(reviewerName);
  const verdictFile = PATHS.verdict(reviewerName);
  const evidenceDir = PATHS.evidence;
  return `You are reviewing iteration ${iteration}.

TASKS:
1. Read spec: ${PATHS.spec}
2. Run: git diff
3. Check ALL acceptance criteria
4. Review evidence in ${evidenceDir}/ (build output, tests, etc)

OUTPUT (MANDATORY):
1. Create ${reviewFile} with:
   # Review: ${reviewerName} (Iteration ${iteration})
   ## Criteria: [x] or [ ] each
   ## Issues: list or None
   ## Evidence Review: Comment on provided evidence
   ## Verdict: APPROVED or REJECTED

2. Write your final verdict to ${verdictFile}:
   - Write exactly 'APPROVED' if all criteria pass AND evidence is sufficient
   - Write exactly 'REJECTED' if any criteria fail OR evidence is missing/insufficient
   This file MUST be created.`;
}
async function runImplementer(claude, iteration, learnings, timeoutMins) {
  const validatedBinary = await validateBinary(claude);
  const sessionId = crypto.randomUUID();
  const name = sanitizeName(path6.basename(claude));
  const configDir = getConfigDirFromBinary(claude);
  const prompt = buildImplementerPrompt(iteration, learnings);
  const promptFile = await writePromptFile(prompt, sessionId);
  const tmuxSession = generateSessionName('impl', name, iteration, sessionId);
  await setAgentRunning(name, sessionId, tmuxSession);
  await recordSession({
    iteration,
    role: AGENT_ROLE.IMPLEMENTER,
    name,
    sessionId,
    tmuxSession,
    configDir,
    time: new Date().toISOString(),
  });
  console.log(`\uD83D\uDD28 Implementing in tmux: ${tmuxSession}`);
  console.log(`   tmux attach -t ${tmuxSession}`);
  const command = `cat "${promptFile}" | "${validatedBinary}" --dangerously-skip-permissions --print --session-id "${sessionId}"`;
  const result = await runInSession(tmuxSession, command, process.cwd(), timeoutMins);
  await cleanupPromptFile(promptFile);
  if (result.timedOut) {
    console.log(`\u23F0 ${name}: Timed out after ${timeoutMins} minutes`);
    await setAgentError(name);
  } else if (result.exitCode !== 0) {
    console.log(`\u26A0\uFE0F ${name}: Exited with code ${result.exitCode}`);
    await setAgentError(name);
  } else {
    await setAgentCompleted(name);
  }
  return {
    name,
    sessionId,
    tmuxSession,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
async function runReviewer(reviewer, iteration, timeoutMins) {
  const sessionId = crypto.randomUUID();
  const name = sanitizeName(path6.basename(reviewer));
  const configDir = getConfigDirFromBinary(reviewer);
  let validatedBinary;
  try {
    validatedBinary = await validateBinary(reviewer);
  } catch (err) {
    console.log(`  \u26A0\uFE0F ${name}: ${err.message}`);
    await setAgentError(name);
    return {
      name,
      verdict: VERDICT.ERROR,
      sessionId,
      tmuxSession: '',
      durationMs: 0,
      exitCode: 1,
      timedOut: false,
    };
  }
  const prompt = buildReviewerPrompt(name, iteration);
  const promptFile = await writePromptFile(prompt, sessionId);
  const tmuxSession = generateSessionName('review', name, iteration, sessionId);
  await setAgentRunning(name, sessionId, tmuxSession);
  await recordSession({
    iteration,
    role: AGENT_ROLE.REVIEWER,
    name,
    sessionId,
    tmuxSession,
    configDir,
    time: new Date().toISOString(),
  });
  console.log(`  \uD83D\uDD0D ${name} in tmux: ${tmuxSession}`);
  const command = `cat "${promptFile}" | "${validatedBinary}" --dangerously-skip-permissions --print --session-id "${sessionId}"`;
  const result = await runInSession(tmuxSession, command, process.cwd(), timeoutMins);
  await cleanupPromptFile(promptFile);
  const verdictText = await readVerdict(name);
  let verdict;
  if (result.timedOut) {
    console.log(`  \u23F0 ${name}: Timed out after ${timeoutMins} minutes`);
    verdict = VERDICT.ERROR;
    await setAgentError(name);
  } else if (result.exitCode !== 0) {
    console.log(`  \u26A0\uFE0F ${name}: Exited with code ${result.exitCode}`);
    verdict = VERDICT.ERROR;
    await setAgentError(name);
  } else if (verdictText === VERDICT.APPROVED) {
    verdict = VERDICT.APPROVED;
    await setAgentCompleted(name, verdict);
  } else if (verdictText === VERDICT.REJECTED) {
    verdict = VERDICT.REJECTED;
    await setAgentCompleted(name, verdict);
  } else {
    verdict = VERDICT.NO_VERDICT;
    await setAgentCompleted(name, verdict);
  }
  const icon = verdict === VERDICT.APPROVED ? '\u2705' : verdict === VERDICT.REJECTED ? '\u274C' : '\u26A0\uFE0F';
  console.log(`  ${icon} ${name}: ${verdict}`);
  return {
    name,
    verdict,
    sessionId,
    tmuxSession,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}
async function runReviewersParallel(reviewers, iteration, timeoutMins) {
  console.log(`\uD83D\uDCCB Reviewing (${reviewers.length} parallel)`);
  console.log(`   To inspect: tmux ls | grep dev-loop-review`);
  const results = await Promise.all(reviewers.map(r => runReviewer(r, iteration, timeoutMins)));
  const approved = results.filter(r => r.verdict === VERDICT.APPROVED).length;
  const rejected = results.filter(r => r.verdict === VERDICT.REJECTED).length;
  const errors = results.filter(r => r.verdict === VERDICT.ERROR || r.verdict === VERDICT.NO_VERDICT).length;
  console.log(`\uD83D\uDCCA Verdicts: ${approved} approved, ${rejected} rejected, ${errors} errors/no verdict`);
  return results;
}

// modules/dev-loop-ts/src/loop.ts
init_types();
init_constants();
async function run() {
  checkBunVersion();
  await checkTmuxAvailable();
  await cleanupStalePromptFiles();
  const config = await loadConfig();
  const currentRun = await createRun(config);
  console.log(`\uD83D\uDD04 DEV LOOP [${currentRun.id}]: ${config.reviewers.length} reviewers, max ${config.maxLoops} loops, ${config.timeoutMins}m timeout
`);
  try {
    while (true) {
      const iteration = await incrementLoop();
      if (iteration > config.maxLoops) {
        await completeRun(RUN_STATUS.MAX_LOOPS);
        console.log(`
${C.yellow}\u26A0\uFE0F Max loops reached (${config.maxLoops})${C.reset}`);
        return;
      }
      console.log(`
${C.bold}\uD83D\uDD01 Iteration ${iteration} / ${config.maxLoops}${C.reset}`);
      await clearEvidence();
      console.log(`\uD83E\uDDF9 Cleared evidence directory`);
      await initAgentStates(iteration, config.claude, config.reviewers);
      await setPhase(PHASE.IMPLEMENTING);
      await clearReviews();
      const currentRunState = await loadRun();
      if (!currentRunState) throw new Error('Run state lost');
      const implResult = await runImplementer(config.claude, iteration, currentRunState.learnings, config.timeoutMins);
      if (implResult.timedOut) {
        console.log(`
${C.red}\u274C Implementer timed out - cannot proceed to review${C.reset}`);
        console.log(`${C.dim}The implementation phase did not complete.${C.reset}`);
        console.log(`${C.dim}Check the tmux session for details, then run 'dev-loop cancel' to abort.${C.reset}`);
        await completeRun(RUN_STATUS.ERROR);
        return;
      }
      if (implResult.exitCode !== 0) {
        console.log(`
${C.yellow}\u26A0\uFE0F Implementer exited with code ${implResult.exitCode}${C.reset}`);
        console.log(`${C.dim}Proceeding to review phase - reviewers will evaluate current state.${C.reset}`);
      }
      const learnings = await readLearnings();
      if (learnings) {
        await addLearning(learnings);
        console.log(`\uD83D\uDCDD Learnings saved`);
      }
      await setPhase(PHASE.REVIEWING);
      const results = await runReviewersParallel(config.reviewers, iteration, config.timeoutMins);
      await setPhase(PHASE.CHECKING);
      const approved = results.filter(r => r.verdict === VERDICT.APPROVED);
      const rejected = results.filter(r => r.verdict === VERDICT.REJECTED);
      const failed = results.filter(r => r.verdict === VERDICT.ERROR || r.verdict === VERDICT.NO_VERDICT);
      console.log(`
${C.bold}\uD83D\uDCCA Consensus check:${C.reset}`);
      console.log(`   ${C.green}\u2705 Approved: ${approved.length}/${results.length}${C.reset}`);
      console.log(`   ${C.red}\u274C Rejected: ${rejected.length}/${results.length}${C.reset}`);
      if (failed.length > 0) {
        console.log(`   ${C.yellow}\u26A0\uFE0F Failed/No verdict: ${failed.length}/${results.length}${C.reset}`);
      }
      const isUnanimous = approved.length === results.length && failed.length === 0;
      if (isUnanimous) {
        await completeRun(RUN_STATUS.COMPLETED);
        console.log(`
${C.green}${C.bold}\uD83C\uDF89 UNANIMOUS APPROVAL (${approved.length}/${results.length}) after ${iteration} iteration(s)${C.reset}`);
        return;
      }
      if (failed.length > 0) {
        console.log(`
${C.yellow}\u26A0\uFE0F ${failed.length} reviewer(s) failed to provide verdict - treating as rejection${C.reset}`);
      }
      if (rejected.length > 0) {
        console.log(`
${C.cyan}\uD83D\uDD04 ${rejected.length} rejection(s) - iterating...${C.reset}`);
      } else if (failed.length > 0) {
        console.log(`
${C.cyan}\uD83D\uDD04 Incomplete consensus - iterating...${C.reset}`);
      }
      await Bun.sleep(1000);
    }
  } catch (err) {
    try {
      await completeRun(RUN_STATUS.ERROR);
    } catch {}
    throw err;
  }
}

// modules/dev-loop-ts/src/cli.ts
init_history();

// modules/dev-loop-ts/src/history-interactive.ts
init_constants();
init_history();
function selectRun(entries) {
  const items = entries.map(entry => {
    const duration = formatDuration(new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime());
    const date = formatDateTime(entry.startTime);
    return {
      text: `${getFinalVerdictIcon(entry.finalVerdict)} ${entry.id} - ${getFinalVerdictText(entry.finalVerdict)}`,
      description: `${date} | ${duration} | ${entry.totalIterations} iter | ${entry.config.reviewers.join(', ')}`,
    };
  });
  const result = createSelection(items, {
    headerText: '\uD83D\uDCDC Select Run to View (\u2191\u2193 navigate, Enter select, Esc quit)',
    perPage: 10,
  });
  if (result.error || result.selectedIndex < 0) {
    return null;
  }
  return entries[result.selectedIndex];
}
function selectViewAction(entry) {
  const items = [
    {
      text: '\uD83D\uDCCA Summary',
      description: 'View run summary with config and final verdict',
    },
    {
      text: '\uD83D\uDD04 Iterations',
      description: `Browse ${entry.totalIterations} iteration(s) in detail`,
    },
    {
      text: '\u2190 Back',
      description: 'Return to run list',
    },
  ];
  const result = createSelection(items, {
    headerText: `\uD83D\uDCDC Run ${entry.id} - What would you like to view?`,
    perPage: 10,
  });
  if (result.error || result.selectedIndex < 0) {
    return null;
  }
  const actions = ['summary', 'iterations', 'back'];
  return actions[result.selectedIndex];
}
function selectIteration(entry) {
  if (entry.iterations.length === 0) {
    console.log(`${C.dim}No iterations recorded for this run.${C.reset}`);
    return null;
  }
  const items = entry.iterations.map(iter => {
    const reviewerSummary = iter.reviewers.map(r => `${getReviewerVerdictIcon(r.verdict)}`).join(' ');
    return {
      text: `Iteration ${iter.iteration}`,
      description: `\uD83D\uDD28 ${iter.implementer.name} | Reviews: ${reviewerSummary || 'none'}`,
    };
  });
  const result = createSelection(items, {
    headerText: `\uD83D\uDD04 Select Iteration to View`,
    perPage: 10,
  });
  if (result.error || result.selectedIndex < 0) {
    return null;
  }
  return entry.iterations[result.selectedIndex];
}
function displaySummary(entry) {
  const duration = formatDuration(new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime());
  console.log('');
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log(`${C.bold}${C.magenta}\uD83D\uDCDC Run Summary: ${entry.id}${C.reset}`);
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log('');
  console.log(
    `${C.bold}Result:${C.reset}     ${getFinalVerdictIcon(entry.finalVerdict)} ${getFinalVerdictText(entry.finalVerdict)}`,
  );
  console.log(`${C.bold}Started:${C.reset}    ${formatDateTime(entry.startTime)}`);
  console.log(`${C.bold}Ended:${C.reset}      ${formatDateTime(entry.endTime)}`);
  console.log(`${C.bold}Duration:${C.reset}   ${duration}`);
  console.log(`${C.bold}Iterations:${C.reset} ${entry.totalIterations}`);
  console.log('');
  console.log(`${C.bold}${C.cyan}Configuration${C.reset}`);
  console.log(
    `${C.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`,
  );
  console.log(`  Implementer: ${C.yellow}${entry.config.claude}${C.reset}`);
  console.log(`  Reviewers:   ${C.yellow}${entry.config.reviewers.join(', ')}${C.reset}`);
  console.log(`  Max loops:   ${C.yellow}${entry.config.maxLoops}${C.reset}`);
  console.log(`  Timeout:     ${C.yellow}${entry.config.timeoutMins}m${C.reset}`);
  console.log('');
  if (entry.iterations.length > 0) {
    console.log(`${C.bold}${C.cyan}Iteration Overview${C.reset}`);
    console.log(
      `${C.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`,
    );
    for (const iter of entry.iterations) {
      const reviewerVerdicts = iter.reviewers.map(r => `${getReviewerVerdictIcon(r.verdict)} ${r.name}`).join(', ');
      console.log(
        `  ${C.bold}#${iter.iteration}${C.reset} \uD83D\uDD28 ${iter.implementer.name} \u2192 ${reviewerVerdicts || 'no reviews'}`,
      );
    }
    console.log('');
  }
}
function displayIteration(entry, iter) {
  console.log('');
  console.log(
    `${C.bold}${C.cyan}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log(`${C.bold}${C.cyan}\uD83D\uDD04 Iteration ${iter.iteration} (Run: ${entry.id})${C.reset}`);
  console.log(
    `${C.bold}${C.cyan}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log('');
  console.log(`${C.bold}\uD83D\uDD28 Implementer${C.reset}`);
  console.log(
    `${C.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`,
  );
  console.log(`  Name:       ${C.yellow}${iter.implementer.name}${C.reset}`);
  console.log(`  Session ID: ${C.dim}${iter.implementer.sessionId}${C.reset}`);
  if (iter.implementer.duration !== undefined) {
    console.log(`  Duration:   ${formatDuration(iter.implementer.duration)}`);
  }
  if (iter.implementer.exitCode !== undefined) {
    const exitIcon = iter.implementer.exitCode === 0 ? '\u2705' : '\u274C';
    console.log(`  Exit Code:  ${exitIcon} ${iter.implementer.exitCode}`);
  }
  console.log('');
  console.log(`${C.bold}\uD83D\uDD0D Reviewers (${iter.reviewers.length})${C.reset}`);
  console.log(
    `${C.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`,
  );
  if (iter.reviewers.length === 0) {
    console.log(`  ${C.dim}No reviewers recorded${C.reset}`);
  } else {
    for (const r of iter.reviewers) {
      const icon = getReviewerVerdictIcon(r.verdict);
      console.log(`  ${icon} ${C.yellow}${r.name}${C.reset}: ${r.verdict}`);
      console.log(`     Session ID: ${C.dim}${r.sessionId}${C.reset}`);
      if (r.duration !== undefined) {
        console.log(`     Duration:   ${formatDuration(r.duration)}`);
      }
    }
  }
  console.log('');
  if (iter.learnings) {
    console.log(`${C.bold}\uD83D\uDCDD Learnings${C.reset}`);
    console.log(
      `${C.dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500${C.reset}`,
    );
    console.log(`${C.green}${iter.learnings}${C.reset}`);
    console.log('');
  }
}
async function browseHistory() {
  const entries = await listHistory();
  if (entries.length === 0) {
    console.log('\u2139\uFE0F No run history found.');
    console.log(`${C.dim}Complete a dev-loop run to see it here.${C.reset}`);
    return;
  }
  while (true) {
    const selectedEntry = selectRun(entries);
    if (!selectedEntry) break;
    while (true) {
      const action = selectViewAction(selectedEntry);
      if (!action || action === 'back') break;
      if (action === 'summary') {
        displaySummary(selectedEntry);
        console.log(`${C.dim}Press Enter to continue...${C.reset}`);
        const reader = Bun.stdin.stream().getReader();
        await reader.read();
        reader.releaseLock();
      } else if (action === 'iterations') {
        while (true) {
          const selectedIter = selectIteration(selectedEntry);
          if (!selectedIter) break;
          displayIteration(selectedEntry, selectedIter);
          console.log(`${C.dim}Press Enter to continue...${C.reset}`);
          const reader = Bun.stdin.stream().getReader();
          await reader.read();
          reader.releaseLock();
        }
      }
    }
  }
}
async function quickViewRun(runId) {
  const entry = await loadHistoryEntry(runId);
  if (!entry) {
    throw new Error(`Run ${runId} not found in history`);
  }
  displaySummary(entry);
  if (entry.iterations.length > 0) {
    console.log(`${C.dim}Use 'dev-loop history' for interactive browsing${C.reset}`);
  }
}

// modules/dev-loop-ts/src/logs.ts
init_constants();
import * as fs6 from 'fs/promises';
function getSessionFilePath(session) {
  return `${session.configDir}/projects/${getProjectHash()}/${session.sessionId}.jsonl`;
}
function formatToolCall(name, input) {
  switch (name) {
    case 'Read':
      return `${C.yellow}\uD83D\uDCD6 Read${C.reset} ${C.dim}${input.file_path || ''}${C.reset}`;
    case 'Write':
      return `${C.yellow}\uD83D\uDCDD Write${C.reset} ${C.dim}${input.file_path || ''}${C.reset}`;
    case 'Edit':
      return `${C.yellow}\u270F\uFE0F  Edit${C.reset} ${C.dim}${input.file_path || ''}${C.reset}`;
    case 'Bash': {
      const desc = input.description || (input.command?.slice(0, 80) ?? '');
      return `${C.yellow}\u26A1 Bash${C.reset} ${C.dim}${desc}${C.reset}`;
    }
    case 'Glob':
      return `${C.yellow}\uD83D\uDD0D Glob${C.reset} ${C.dim}${input.pattern || ''}${C.reset}`;
    case 'Grep':
      return `${C.yellow}\uD83D\uDD0E Grep${C.reset} ${C.dim}${input.pattern || ''}${C.reset}`;
    case 'Task':
      return `${C.yellow}\uD83E\uDD16 Task${C.reset} ${C.dim}${input.description || ''}${C.reset}`;
    case 'TodoWrite':
      return `${C.yellow}\uD83D\uDCCB TodoWrite${C.reset}`;
    default:
      return `${C.yellow}\uD83D\uDD27 ${name}${C.reset}`;
  }
}
async function formatSession(sessionFile) {
  const file = Bun.file(sessionFile);
  if (!(await file.exists())) {
    return `\u274C Session file not found: ${sessionFile}`;
  }
  try {
    const stat4 = await fs6.stat(sessionFile);
    if (stat4.size > MAX_SESSION_FILE_SIZE) {
      const sizeMB = (stat4.size / (1024 * 1024)).toFixed(1);
      return `\u26A0\uFE0F Session file too large (${sizeMB}MB > ${MAX_SESSION_FILE_SIZE / (1024 * 1024)}MB limit): ${sessionFile}
Use 'tail -f ${sessionFile}' to view directly.`;
    }
  } catch {}
  const content = await file.text();
  const lines = content.trim().split(`
`);
  const output = [];
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const msgType = msg.type;
      if (msgType === 'user') {
        if (!msg.toolUseResult) {
          const messageContent = msg.message?.content;
          if (typeof messageContent === 'string' && messageContent) {
            output.push('');
            output.push(
              `${C.bold}${C.blue}\u2501\u2501\u2501 \uD83D\uDC64 USER \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
            );
            output.push(
              `${C.blue}${messageContent
                .split(
                  `
`,
                )
                .slice(0, 30).join(`
`)}${C.reset}`,
            );
          }
        } else {
          output.push(`  ${C.dim}\u21B3 Tool completed${C.reset}`);
        }
      } else if (msgType === 'assistant') {
        const contents = msg.message?.content;
        if (Array.isArray(contents)) {
          for (const item of contents) {
            if (item.type === 'text' && item.text) {
              output.push('');
              output.push(
                `${C.bold}${C.green}\u2501\u2501\u2501 \uD83E\uDD16 CLAUDE \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
              );
              output.push(
                `${C.green}${item.text
                  .split(
                    `
`,
                  )
                  .slice(0, 50).join(`
`)}${C.reset}`,
              );
            } else if (item.type === 'tool_use' && item.name) {
              output.push(formatToolCall(item.name, item.input || {}));
            }
          }
        }
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`Warning: Failed to parse JSONL line: ${err.message}`);
      }
    }
  }
  return output.join(`
`);
}
async function listSessions() {
  const sessions = await getSessions();
  if (sessions.length === 0) {
    console.log('\u2139\uFE0F No sessions recorded yet.');
    return;
  }
  console.log(`\uD83D\uDCCB Dev Loop Sessions
`);
  let currentIter = -1;
  for (const s of sessions) {
    if (s.iteration !== currentIter) {
      currentIter = s.iteration;
      console.log(`
\u2550\u2550\u2550 Iteration ${s.iteration} \u2550\u2550\u2550`);
    }
    const emoji = getAgentRoleIcon(s.role);
    const time = formatTime(s.time);
    console.log(`  ${emoji} ${s.role.padEnd(12)} \u2502 ${s.name.padEnd(20)} \u2502 ${time}`);
  }
}
async function viewSession(iteration, roleOrName) {
  const sessions = await getSessions(iteration);
  const session = sessions.find(s => s.role === roleOrName || s.name === roleOrName);
  if (!session) {
    throw new Error(`Session not found: iteration ${iteration}, ${roleOrName}`);
  }
  const sessionFile = getSessionFilePath(session);
  const emoji = getAgentRoleIcon(session.role);
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log(
    `${C.bold}${C.magenta}${emoji} Iteration ${session.iteration}: ${session.name} (${session.role})${C.reset}`,
  );
  console.log(`${C.bold}${C.magenta}\uD83D\uDCC4 ${sessionFile}${C.reset}`);
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  const formatted = await formatSession(sessionFile);
  console.log(formatted);
}

// modules/dev-loop-ts/src/logs-interactive.ts
init_constants();
function groupSessionsByIteration(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const existing = groups.get(s.iteration);
    if (existing) {
      existing.push(s);
    } else {
      groups.set(s.iteration, [s]);
    }
  }
  return Array.from(groups.entries())
    .map(([iteration, sessions2]) => ({ iteration, sessions: sessions2 }))
    .sort((a, b) => b.iteration - a.iteration);
}
function selectIteration2(iterations) {
  const items = iterations.map(({ iteration, sessions }) => {
    const implementer = sessions.find(s => s.role === 'implementer');
    const reviewers = sessions.filter(s => s.role === 'reviewer');
    return {
      text: `Iteration ${iteration}`,
      description: `${sessions.length} session(s) \u2022 ${implementer?.name || 'No implementer'} \u2022 ${reviewers.length} reviewer(s)`,
    };
  });
  const result = createSelection(items, {
    headerText: '\uD83D\uDCCB Select Iteration (\u2191\u2193 navigate, Enter select, Esc quit)',
    perPage: 10,
  });
  if (result.error || result.selectedIndex < 0) {
    return null;
  }
  return iterations[result.selectedIndex];
}
function selectSession(iteration) {
  const { sessions } = iteration;
  const items = sessions.map(s => {
    const emoji = getAgentRoleIcon(s.role);
    const time = formatTime(s.time);
    const roleLabel = getAgentRoleLabel(s.role);
    return {
      text: `${emoji} ${roleLabel}: ${s.name}`,
      description: `Session: ${s.sessionId.slice(0, 8)}... \u2022 Time: ${time}`,
    };
  });
  const result = createSelection(items, {
    headerText: `\uD83D\uDCCB Iteration ${iteration.iteration} - Select Agent`,
    perPage: 10,
  });
  if (result.error || result.selectedIndex < 0) {
    return null;
  }
  return sessions[result.selectedIndex];
}
async function displaySession(session) {
  const sessionFile = getSessionFilePath(session);
  const emoji = getAgentRoleIcon(session.role);
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  console.log(
    `${C.bold}${C.magenta}${emoji} Iteration ${session.iteration}: ${session.name} (${session.role})${C.reset}`,
  );
  console.log(`${C.bold}${C.magenta}\uD83D\uDCC4 ${sessionFile}${C.reset}`);
  console.log(
    `${C.bold}${C.magenta}\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501${C.reset}`,
  );
  const formatted = await formatSession(sessionFile);
  console.log(formatted);
}
async function browseSessions() {
  const sessions = await getSessions();
  if (sessions.length === 0) {
    console.log('\u2139\uFE0F No sessions recorded yet.');
    return;
  }
  const iterations = groupSessionsByIteration(sessions);
  while (true) {
    const selectedIter = selectIteration2(iterations);
    if (!selectedIter) break;
    const selectedSession = selectSession(selectedIter);
    if (!selectedSession) continue;
    await displaySession(selectedSession);
    console.log(`
${C.dim}Press Enter to continue browsing...${C.reset}`);
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    reader.releaseLock();
  }
}

// modules/dev-loop-ts/src/cli.ts
init_types();
init_constants();
var isShuttingDown = false;
var cleanupComplete = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    while (!cleanupComplete) {
      await Bun.sleep(100);
    }
    return;
  }
  isShuttingDown = true;
  console.log(`
${C.yellow}Received ${signal}, cleaning up...${C.reset}`);
  try {
    const sessions = await listAgentSessions();
    if (sessions.length > 0) {
      console.log(`Killing ${sessions.length} agent session(s)...`);
      await killAgentSessions();
    }
  } catch (err) {
    console.error(`Cleanup error: ${err.message}`);
  }
  cleanupComplete = true;
}
function setupSignalHandlers() {
  const handleSignal = signal => {
    gracefulShutdown(signal)
      .then(() => process.exit(0))
      .catch(err => {
        console.error(`Shutdown error: ${err}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}
var program2 = new Command()
  .name('dev-loop')
  .description('Spec-driven development with multi-reviewer consensus')
  .version('1.0.0');
program2
  .command('init')
  .description('Initialize dev-loop configuration (spec + config)')
  .option('--claude <cmd>', 'implementer binary', 'claude')
  .option('--reviewers <list>', 'comma-separated reviewers', 'claude-reviewer-zai')
  .option('--max-loops <n>', 'maximum iterations', '20')
  .option('--timeout <mins>', 'timeout per agent in minutes', '20')
  .action(async opts => {
    try {
      const config = validateConfig({
        claude: opts.claude,
        reviewers: opts.reviewers
          .split(',')
          .map(r => r.trim())
          .filter(r => r.length > 0),
        maxLoops: parseInt(opts.maxLoops, 10),
        timeoutMins: parseInt(opts.timeout, 10),
      });
      await initProject(config);
      console.log(`${C.green}\u2705 Dev Loop Initialized${C.reset}`);
      console.log(`\uD83D\uDCC4 Spec: ${PATHS.spec}`);
      console.log(`\u2699\uFE0F Config: ${PATHS.config}`);
      console.log(`\uD83D\uDD22 Max loops: ${config.maxLoops}`);
      console.log(`\uD83D\uDC65 Reviewers: ${config.reviewers.join(', ')}`);
      console.log(`\uD83E\uDD16 Implementer: ${config.claude}`);
      console.log(`\u23F1\uFE0F Timeout: ${config.timeoutMins}m per agent`);
      console.log('');
      console.log(`${C.dim}\uD83D\uDC49 Next: edit spec, then run: dev-loop run${C.reset}`);
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
program2
  .command('config')
  .description('View or update configuration')
  .option('--claude <cmd>', 'set implementer binary')
  .option('--reviewers <list>', 'set comma-separated reviewers')
  .option('--max-loops <n>', 'set maximum iterations')
  .option('--timeout <mins>', 'set timeout per agent')
  .action(async opts => {
    try {
      const hasUpdates = opts.claude || opts.reviewers || opts.maxLoops || opts.timeout;
      if (hasUpdates) {
        const updates = {};
        if (opts.claude) updates.claude = opts.claude;
        if (opts.reviewers) updates.reviewers = opts.reviewers.split(',').map(r => r.trim());
        if (opts.maxLoops) updates.maxLoops = parseInt(opts.maxLoops, 10);
        if (opts.timeout) updates.timeoutMins = parseInt(opts.timeout, 10);
        const config = await updateConfig(updates);
        console.log(`${C.green}\u2705 Config updated${C.reset}`);
        console.log(JSON.stringify(config, null, 2));
      } else {
        const config = await loadConfig();
        console.log(`${C.bold}\u2699\uFE0F Configuration${C.reset}
`);
        console.log(`  Implementer: ${C.yellow}${config.claude}${C.reset}`);
        console.log(`  Reviewers:   ${C.yellow}${config.reviewers.join(', ')}${C.reset}`);
        console.log(`  Max loops:   ${C.yellow}${config.maxLoops}${C.reset}`);
        console.log(`  Timeout:     ${C.yellow}${config.timeoutMins}m${C.reset}`);
        console.log('');
        console.log(`${C.dim}File: ${PATHS.config}${C.reset}`);
      }
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
program2
  .command('run')
  .description('Execute a new dev-loop run (idempotent - can run multiple times)')
  .action(async () => {
    setupSignalHandlers();
    try {
      await run();
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
program2
  .command('status')
  .description('Show current run status')
  .action(async () => {
    try {
      const config = await loadConfig();
      const run2 = await loadRun();
      console.log(`${C.bold}\uD83D\uDCCA Dev Loop Status${C.reset}
`);
      if (!run2) {
        console.log(`${C.dim}No active run.${C.reset}`);
        console.log('');
        console.log(`${C.bold}Config:${C.reset}`);
        console.log(`  Implementer: ${C.yellow}${config.claude}${C.reset}`);
        console.log(`  Reviewers:   ${C.yellow}${config.reviewers.join(', ')}${C.reset}`);
        console.log('');
        console.log(`${C.dim}Run 'dev-loop run' to start a new run.${C.reset}`);
        return;
      }
      const statusIcon =
        run2.status === 'running'
          ? '\uD83D\uDFE2'
          : run2.status === 'completed'
            ? '\u2705'
            : run2.status === 'cancelled'
              ? '\uD83D\uDED1'
              : '\u26A0\uFE0F';
      console.log(`${C.bold}Run:${C.reset} ${C.cyan}${run2.id}${C.reset} ${statusIcon} ${run2.status.toUpperCase()}`);
      console.log(
        `${C.bold}Loop:${C.reset} ${C.yellow}${run2.loop}${C.reset} / ${config.maxLoops}  Phase: ${C.cyan}${run2.phase.toUpperCase()}${C.reset}`,
      );
      console.log(`${C.bold}Started:${C.reset} ${formatDateTime(run2.startTime)}`);
      console.log('');
      const agents = await getAllAgentStates();
      if (agents.length > 0) {
        console.log(`${C.bold}Agents:${C.reset}`);
        const impl = agents.find(a => a.role === 'implementer');
        if (impl) {
          const icon =
            impl.status === AGENT_STATUS.RUNNING
              ? '\uD83D\uDFE2'
              : impl.status === AGENT_STATUS.COMPLETED
                ? '\u2705'
                : impl.status === AGENT_STATUS.ERROR
                  ? '\u274C'
                  : '\u23F8\uFE0F';
          console.log(`  ${icon} ${C.cyan}impl${C.reset} ${impl.name} [iter ${impl.iteration}]`);
          if (impl.tmuxSession && impl.status === AGENT_STATUS.RUNNING) {
            console.log(`       tmux: ${impl.tmuxSession}`);
          }
        }
        const reviewers = agents.filter(a => a.role === 'reviewer');
        for (const r of reviewers) {
          const icon =
            r.status === AGENT_STATUS.RUNNING
              ? '\uD83D\uDFE2'
              : r.status === AGENT_STATUS.COMPLETED
                ? '\u2705'
                : r.status === AGENT_STATUS.ERROR
                  ? '\u274C'
                  : '\u23F8\uFE0F';
          const verdict = r.verdict ? ` \u2192 ${r.verdict}` : '';
          console.log(`  ${icon} ${C.magenta}review${C.reset} ${r.name} [iter ${r.iteration}]${verdict}`);
          if (r.tmuxSession && r.status === AGENT_STATUS.RUNNING) {
            console.log(`       tmux: ${r.tmuxSession}`);
          }
        }
        console.log('');
      }
      if (run2.learnings.length > 0) {
        console.log(`${C.bold}Recent Learnings:${C.reset}`);
        run2.learnings.slice(-3).forEach(l => {
          const preview = l.content
            .split(
              `
`,
            )[0]
            .slice(0, 60);
          console.log(`  [${C.yellow}${l.iteration}${C.reset}] ${preview}${l.content.length > 60 ? '...' : ''}`);
        });
        console.log('');
      }
      console.log(`${C.dim}Commands: dev-loop attach | dev-loop cancel | dev-loop logs${C.reset}`);
    } catch (err) {
      const message = err.message || '';
      if (message.includes('No dev-loop') || message.includes('ENOENT')) {
        console.log(`\u2139\uFE0F No dev-loop found. Run: dev-loop init`);
      } else {
        console.error(`${C.red}\u274C ${message}${C.reset}`);
      }
    }
  });
program2
  .command('attach')
  .description('Interactively attach to a running tmux session')
  .action(async () => {
    try {
      const sessions = await listAgentSessions();
      if (sessions.length === 0) {
        console.log(`\u2139\uFE0F No running agent sessions.`);
        return;
      }
      const items = await Promise.all(
        sessions.map(async sessionName => {
          const alive = await isTmuxSessionAlive(sessionName);
          const parsed = parseSessionName(sessionName);
          let roleLabel = 'Unknown';
          let name = sessionName;
          let iteration = '?';
          if (parsed) {
            roleLabel = parsed.role === 'impl' ? '\uD83D\uDD28 Implementer' : '\uD83D\uDD0D Reviewer';
            name = parsed.agentName;
            iteration = String(parsed.iteration);
          }
          return {
            text: `${roleLabel}: ${name}`,
            description: `Iteration ${iteration} | ${alive ? '\uD83D\uDFE2 Active' : '\u26AB Finished'} | ${sessionName}`,
            sessionName,
          };
        }),
      );
      const result = createSelection(items, {
        headerText: '\uD83D\uDCCB Select session to attach (\u2191\u2193 navigate, Enter select, Esc quit)',
        perPage: 10,
      });
      if (result.error || result.selectedIndex < 0) {
        return;
      }
      const selected = items[result.selectedIndex];
      console.log(`
${C.cyan}Attaching to ${selected.sessionName}...${C.reset}`);
      console.log(`${C.dim}Press Ctrl+B then D to detach${C.reset}
`);
      const proc = Bun.spawn(['tmux', 'attach', '-t', selected.sessionName], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      await proc.exited;
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
program2
  .command('cancel')
  .description('Stop current run and archive it')
  .action(async () => {
    try {
      const run2 = await loadRun();
      if (!run2) {
        console.log(`\u2139\uFE0F No active run to cancel.`);
        return;
      }
      console.log(`Cancelling run ${run2.id}...`);
      await cancelRun();
      console.log(`\uD83D\uDED1 Run cancelled and archived.`);
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
var historyCmd = program2.command('history').description('View run history (interactive)');
historyCmd
  .command('browse')
  .description('Interactive history browser')
  .action(async () => {
    try {
      await browseHistory();
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
historyCmd
  .command('list')
  .alias('ls')
  .description('List all past runs (non-interactive)')
  .action(async () => {
    try {
      await showHistory();
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
    }
  });
historyCmd
  .command('show <run-id>')
  .description('Show details of a specific run')
  .action(async runId => {
    try {
      await quickViewRun(runId);
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
historyCmd
  .command('clear')
  .description('Clear all run history')
  .action(async () => {
    try {
      await clearHistory();
      console.log(`\uD83D\uDDD1\uFE0F History cleared.`);
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
historyCmd.action(async () => {
  try {
    await browseHistory();
  } catch (err) {
    console.error(`${C.red}\u274C ${err.message}${C.reset}`);
    process.exit(1);
  }
});
var logsCmd = program2.command('logs').description('View session logs (current run)');
logsCmd
  .command('list')
  .alias('ls')
  .description('List all sessions in current run')
  .action(async () => {
    try {
      await listSessions();
    } catch (err) {
      const message = err.message || '';
      if (message.includes('No dev-loop') || message.includes('ENOENT') || message.includes('No active')) {
        console.log(`\u2139\uFE0F No active run.`);
      } else {
        console.error(`${C.red}\u274C ${message}${C.reset}`);
      }
    }
  });
logsCmd
  .command('view <iteration> <role>')
  .description('View a specific session (role: implementer or reviewer name)')
  .action(async (iteration, role) => {
    try {
      const iter = parseInt(iteration, 10);
      if (!Number.isFinite(iter) || iter < 1) {
        throw new Error('Invalid iteration number');
      }
      await viewSession(iter, role);
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
logsCmd
  .command('browse')
  .alias('fzf')
  .description('Interactive browser')
  .action(async () => {
    try {
      await browseSessions();
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
logsCmd.action(async () => {
  try {
    await browseSessions();
  } catch (err) {
    console.error(`${C.red}\u274C ${err.message}${C.reset}`);
    process.exit(1);
  }
});
program2
  .command('destroy')
  .description('Remove all dev-loop data (spec, config, history)')
  .action(async () => {
    try {
      await destroyAll();
      console.log(`\uD83D\uDDD1\uFE0F All dev-loop data removed.`);
    } catch (err) {
      console.error(`${C.red}\u274C ${err.message}${C.reset}`);
      process.exit(1);
    }
  });
program2.parse();
