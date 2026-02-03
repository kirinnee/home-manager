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

// modules/dev-loop-ts/node_modules/picocolors/picocolors.js
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

// modules/dev-loop-ts/node_modules/sisteransi/src/index.js
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

// modules/dev-loop-ts/node_modules/zod/v3/external.js
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

// modules/dev-loop-ts/node_modules/zod/v3/helpers/util.js
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

// modules/dev-loop-ts/node_modules/zod/v3/ZodError.js
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

// modules/dev-loop-ts/node_modules/zod/v3/locales/en.js
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

// modules/dev-loop-ts/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
// modules/dev-loop-ts/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = params => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...(issueData.path || [])];
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
// modules/dev-loop-ts/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function (errorUtil2) {
  errorUtil2.errToObj = message => (typeof message === 'string' ? { message } : message || {});
  errorUtil2.toString = message => (typeof message === 'string' ? message : message?.message);
})(errorUtil || (errorUtil = {}));

// modules/dev-loop-ts/node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
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
// modules/dev-loop-ts/src/types.ts
var configSchema = exports_external.object({
  implementer: exports_external.string().min(1).default('claude'),
  reviewers: exports_external.array(exports_external.string().min(1)).min(1).default(['claude-reviewer-zai']),
  maxIterations: exports_external.number().min(1).max(100).default(10),
  implementerTimeout: exports_external.number().min(1).max(120).default(30),
  reviewerTimeout: exports_external.number().min(1).max(120).default(15),
});
var runStatusSchema = exports_external.enum(['running', 'completed', 'cancelled', 'failed']);
var phaseSchema = exports_external.enum(['implementing', 'reviewing', 'done']);
var agentRoleSchema = exports_external.enum(['implementer', 'reviewer']);
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
});
var verdictFileSchema = exports_external.object({
  verdict: verdictSchema,
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
});
var historyEntrySchema = exports_external.object({
  id: exports_external.string().min(1),
  spec: exports_external.string(),
  config: configSchema,
  status: runStatusSchema,
  iterations: exports_external.number().int().nonnegative(),
  startedAt: exports_external.string().datetime(),
  completedAt: exports_external.string().datetime(),
  summary: exports_external.array(iterationSummarySchema),
});
var DEFAULT_CONFIG = {
  implementer: 'claude',
  reviewers: ['claude-reviewer-zai'],
  maxIterations: 10,
  implementerTimeout: 30,
  reviewerTimeout: 15,
};
function parseConfig(data) {
  return configSchema.parse(data);
}
function parseRun(data) {
  return runSchema.parse(data);
}
function parseSession(data) {
  return sessionSchema.parse(data);
}
function parseVerdictFile(data) {
  return verdictFileSchema.parse(data);
}
function parseHistoryEntry(data) {
  return historyEntrySchema.parse(data);
}

// modules/dev-loop-ts/src/state/config.ts
function mergeConfig(partial) {
  return {
    implementer: partial.implementer ?? DEFAULT_CONFIG.implementer,
    reviewers: partial.reviewers ?? DEFAULT_CONFIG.reviewers,
    maxIterations: partial.maxIterations ?? DEFAULT_CONFIG.maxIterations,
    implementerTimeout: partial.implementerTimeout ?? DEFAULT_CONFIG.implementerTimeout,
    reviewerTimeout: partial.reviewerTimeout ?? DEFAULT_CONFIG.reviewerTimeout,
  };
}
function configFromOptions(opts) {
  const partial = {};
  if (opts.implementer) partial.implementer = opts.implementer;
  if (opts.reviewers && opts.reviewers.length > 0) partial.reviewers = opts.reviewers;
  if (opts.maxIterations !== undefined) partial.maxIterations = opts.maxIterations;
  if (opts.implementerTimeout !== undefined) partial.implementerTimeout = opts.implementerTimeout;
  if (opts.reviewerTimeout !== undefined) partial.reviewerTimeout = opts.reviewerTimeout;
  return mergeConfig(partial);
}

// modules/dev-loop-ts/src/cli/init.ts
async function handler(opts, state) {
  try {
    const reviewersList = opts.reviewers
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const cfg = configFromOptions({
      implementer: opts.implementer || undefined,
      reviewers: reviewersList.length > 0 ? reviewersList : undefined,
      maxIterations: parseInt(opts.maxIterations, 10) || undefined,
      implementerTimeout: parseInt(opts.implementerTimeout, 10) || undefined,
      reviewerTimeout: parseInt(opts.reviewerTimeout, 10) || undefined,
    });
    await state.initProject(cfg);
    console.log('Dev Loop Initialized');
    console.log(`  Implementer: ${cfg.implementer}`);
    console.log(`  Reviewers: ${cfg.reviewers.join(', ')}`);
    console.log(`  Max iterations: ${cfg.maxIterations}`);
    console.log(`  Implementer timeout: ${cfg.implementerTimeout}m`);
    console.log(`  Reviewer timeout: ${cfg.reviewerTimeout}m`);
    console.log('');
    console.log('Next: edit .kagent/spec.md, then run: dev-loop run');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// modules/dev-loop-ts/src/loop/runner.ts
import * as fs2 from 'fs/promises';

// modules/dev-loop-ts/src/deps.ts
import * as path from 'path';
import * as fs from 'fs/promises';
var BASE_DIR = '.kagent';
var CURRENT_DIR = `${BASE_DIR}/current`;
var SESSIONS_DIR = `${CURRENT_DIR}/sessions`;
var VERDICTS_DIR = `${CURRENT_DIR}/verdicts`;
var EVIDENCE_DIR = `${CURRENT_DIR}/evidence`;
var HISTORY_DIR = `${BASE_DIR}/history`;
var LOGS_DIR = `${BASE_DIR}/logs`;
var REVIEWS_DIR = `${BASE_DIR}/reviews`;
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
  historyEntry: runId => `${HISTORY_DIR}/${runId}.json`,
  verdictFile: (iteration, reviewerIndex) => `${VERDICTS_DIR}/${iteration}-${reviewerIndex}.json`,
  sessionFile: sessionId => `${SESSIONS_DIR}/${sessionId}.json`,
  runLogsDir: runId => `${LOGS_DIR}/${runId}`,
  runReviewsDir: runId => `${REVIEWS_DIR}/${runId}`,
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

// modules/dev-loop-ts/src/loop/consensus.ts
function checkConsensus(verdicts) {
  const approved = verdicts.filter(v => v.verdict === 'approved');
  const rejected = verdicts.filter(v => v.verdict === 'rejected');
  const incomplete = verdicts.filter(v => v.verdict !== 'approved' && v.verdict !== 'rejected');
  return {
    approved: approved.length === verdicts.length && incomplete.length === 0,
    rejected: rejected.length > 0,
    incomplete: incomplete.length > 0,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    totalReviewers: verdicts.length,
  };
}
function formatConsensusResult(result) {
  return `Approved: ${result.approvedCount}/${result.totalReviewers}, Rejected: ${result.rejectedCount}/${result.totalReviewers}`;
}

// modules/dev-loop-ts/src/agents/prompts.ts
function buildImplementerPrompt(params) {
  const { iteration, specPath, specContent, previousLoopLearnings, currentLoopReviews } = params;
  const evidenceDir = `.kagent/current/evidence`;
  const learningsFile = `.kagent/current/learnings.md`;
  const hasReviews = currentLoopReviews && currentLoopReviews.length > 0;
  const reviewsText = hasReviews
    ? `
PREVIOUS REVIEW FEEDBACK (from last loop):
${currentLoopReviews.map(r => `- ${r}`).join(`
`)}
`
    : '';
  const learningsText =
    previousLoopLearnings.length > 0
      ? `
LEARNINGS FROM PREVIOUS LOOPS:
${previousLoopLearnings.map(l => `- ${l}`).join(`
`)}
`
      : '';
  return `# Implementation Task

## Specification

${specContent}

## Context

- Loop: ${iteration}
- Spec: ${specPath}
${reviewsText}
${learningsText}

## Instructions

1. Read and understand the specification completely
2. If there are learnings or review feedback above, address those issues first
3. Implement the required changes
4. Run ALL tests and verify they pass
5. Run the build and verify it succeeds
6. Write evidence to ${evidenceDir}/:
   - build-output.log: Complete build command output
   - test-output.log: Complete test command output
   - evidence.md: Summary of what you verified and how
7. Write learnings to ${learningsFile}:
   - Document any roadblocks encountered
   - Note workarounds or discoveries
   - Document any decisions made and why
   - This helps the next iteration if reviewers find issues

## Important

- Do not interact with the user. Work autonomously.
- Be thorough - reviewers will verify your work independently.
- If tests fail, fix them before completing.
- If build fails, fix it before completing.
- Document everything in evidence so reviewers can verify.

## Test/Build Commands

Auto-detect and use the appropriate commands:
- Makefile: \`make test\`, \`make build\`
- Taskfile.yml: \`task test\`, \`task build\`
- justfile: \`just test\`, \`just build\`
- CI config: Use exact commands from CI configuration
- If none detected, prompt user for commands

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches
- NEVER rebase pushed commits
- If push fails, use \`git pull\` and merge, never force
- Do NOT commit changes - the run will commit on successful completion
`;
}
function buildReviewerPrompt(params) {
  const { iteration, reviewerIndex, specPath } = params;
  const evidenceDir = `.kagent/current/evidence`;
  const reviewsDir = `.kagent/current/reviews`;
  const reviewFile = `${reviewsDir}/reviewer-${reviewerIndex}.md`;
  const verdictFile = `.kagent/current/verdicts/${iteration}-${reviewerIndex}.json`;
  const learningsFile = `.kagent/current/learnings.md`;
  return `# Code Review Task

## Specification

Read the spec from: ${specPath}

## Your Task

You are Reviewer ${reviewerIndex} for loop ${iteration}.

1. Review the current implementation against the specification
2. Check the evidence in ${evidenceDir}/
3. Run \`git diff\` to see the changes
4. Run the tests yourself to verify they pass
5. Run the build yourself to verify it succeeds
6. Check CLAUDE.md in the project root (if exists) - ensure all changes conform to those guidelines
7. Check for any relevant skills in the project - ensure implementation follows best practices
8. Write your review to ${reviewFile}
9. Write your verdict to ${verdictFile}:
   \`\`\`json
   {
     "verdict": "approved" or "rejected",
     "reasoning": "Your detailed reasoning here",
     "completionEstimate": 0-100 (percentage of spec completion - be conservative, 100% only if ALL acceptance criteria are met)
   }
   \`\`\`

## Completion Estimate Guidelines

Estimate how much of the specification has been completed:
- 0-30%: Basic structure started, most features missing
- 30-60%: Core features implemented, but incomplete or buggy
- 60-90%: Most features working, edge cases or polish needed
- 100%: ALL acceptance criteria fully met, tests passing, no known issues

**Be conservative** - it's better to underestimate than overestimate. Only give 100% if the spec is truly complete.

## Review Criteria - BE STRICT

You must verify ALL of the following. Reject if ANY criterion fails:

### 1. Specification Compliance

- Does the implementation address EVERY requirement in the spec?
- Are there any spec requirements that were missed or partially implemented?
- Does the behavior match what was specified exactly?

### 2. Code Quality

- Is the code clean, readable, and maintainable?
- Are there any obvious bugs or logic errors?
- Is error handling appropriate?
- Are edge cases handled?

### 3. Testing

- Do ALL tests pass? (Run them yourself, don't trust evidence alone)
- Is test coverage adequate for the changes?
- Are there missing test cases for important scenarios?

### 4. Build & Integration

- Does the build succeed without warnings? (Run it yourself)
- Are there any type errors or linting issues?
- Does the change integrate properly with existing code?

### 5. Security

- Are there any security vulnerabilities introduced?
- Is user input properly validated?
- Are there any injection risks (SQL, XSS, command injection)?

### 6. Evidence Verification

- Did the implementer provide complete evidence?
- Do the evidence files match what you observe when running commands yourself?
- Are there any discrepancies between claimed and actual results?

### 7. CLAUDE.md / Skills Compliance

- If CLAUDE.md exists in the project root, do all changes follow those guidelines?
- Are there relevant skills in the project that should be followed?
- Does the implementation match the project's coding standards and conventions?

## Verdict Guidelines

**APPROVE only if:**

- ALL specification requirements are fully implemented
- ALL tests pass when you run them
- Build succeeds when you run it
- Code quality is acceptable
- No security issues identified
- Evidence is accurate and complete
- Changes conform to CLAUDE.md (if present) and relevant skills

**REJECT if:**

- ANY specification requirement is missing or incomplete
- ANY test fails
- Build fails or has errors
- Significant code quality issues
- Security vulnerabilities present
- Evidence is missing, incomplete, or inaccurate
- Changes violate CLAUDE.md guidelines or relevant skills
- You have ANY doubt about the implementation correctness

When in doubt, REJECT. It is better to have another iteration than to approve incomplete work.

## Learnings

You can also check ${learningsFile} to understand what the implementer learned during this iteration. This may provide context for their decisions.

## Git Safety - CRITICAL

- NEVER use \`git push --force\` or \`git push -f\`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches
- NEVER rebase pushed commits
- Reject if you see any evidence of force pushing or unsafe git operations

Be thorough and strict. Your review ensures quality.
`;
}

// modules/dev-loop-ts/src/loop/iteration.ts
function buildIterationData(run, config, specPath, specContent) {
  const implementerPrompt = buildImplementerPrompt({
    iteration: run.iteration,
    specPath,
    specContent,
    previousLoopLearnings: run.learnings ?? [],
  });
  const reviewerPrompts = Array.from({ length: config.reviewers.length }, (_, i) => ({
    reviewerIndex: i,
    prompt: buildReviewerPrompt({
      iteration: run.iteration,
      reviewerIndex: i,
      specPath,
      specContent,
    }),
  }));
  return {
    run,
    config,
    spec: specContent,
    learnings: run.learnings,
    implementerPrompt,
    reviewerPrompts,
  };
}

// modules/dev-loop-ts/src/loop/runner.ts
class CancelledError extends Error {
  archived;
  constructor(message, archived = false) {
    super(message);
    this.archived = archived;
    this.name = 'CancelledError';
  }
}
function isNoActiveRunError(error) {
  return error instanceof Error && error.message === 'No active run';
}

class LoopRunner {
  state;
  tmux;
  agentRunner;
  constructor(state, tmux, agentRunner) {
    this.state = state;
    this.tmux = tmux;
    this.agentRunner = agentRunner;
  }
  async run() {
    const existingRun = await this.state.loadRun();
    if (existingRun && existingRun.status === 'running') {
      throw new Error(
        `A run is already in progress (${existingRun.id}).
` + `Use 'dev-loop attach' to view it, 'dev-loop status' to check status, or 'dev-loop cancel' to stop it.`,
      );
    }
    if (existingRun && existingRun.status !== 'running') {
      console.log(`Archiving previous run (${existingRun.id})...`);
      await this.state.archiveRun();
    }
    const config = await this.state.loadConfig();
    const run = await this.state.createRun('.kagent/spec.md');
    const dirHash = getDirHash(process.cwd());
    console.log(
      `DEV LOOP [${run.id}]: ${config.reviewers.length} reviewers (${config.reviewers.join(', ')}), max ${config.maxIterations} iterations`,
    );
    let currentRun = run;
    try {
      while (currentRun.iteration < config.maxIterations) {
        await this.assertRunActive();
        const iterResult = await this.runIteration(currentRun, config, dirHash);
        if (iterResult.approved) {
          const entry2 = await this.state.completeRun('completed');
          console.log(`UNANIMOUS APPROVAL after ${iterResult.iteration} iteration(s)`);
          return {
            status: 'completed',
            finalRun: currentRun,
            historyEntry: entry2,
          };
        }
        currentRun = (await this.state.loadRun()) ?? currentRun;
      }
      const entry = await this.state.completeRun('completed');
      console.log(`Max iterations reached (${config.maxIterations})`);
      return {
        status: 'max_iterations',
        finalRun: currentRun,
        historyEntry: entry,
      };
    } catch (error) {
      if (error instanceof CancelledError || isNoActiveRunError(error)) {
        let entry2 = null;
        const stillActive = await this.state.loadRun();
        if (stillActive) {
          entry2 = await this.state.completeRun('cancelled');
        } else {
          const history = await this.state.listHistory();
          if (history.length > 0) {
            entry2 = history.find(h => h.id === currentRun.id) ?? history[0];
          }
        }
        if (!entry2) {
          throw error;
        }
        return {
          status: 'cancelled',
          finalRun: currentRun,
          historyEntry: entry2,
        };
      }
      console.error('Loop error:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) console.error(error.stack);
      const entry = await this.state.completeRun('failed');
      return {
        status: 'failed',
        finalRun: currentRun,
        historyEntry: entry,
      };
    }
  }
  async assertRunActive() {
    const run = await this.state.loadRun();
    if (!run) {
      throw new CancelledError('Run was cancelled and archived', true);
    }
    if (run.status === 'cancelled') {
      throw new CancelledError('Run was cancelled');
    }
  }
  async runIteration(run, config, dirHash) {
    await this.assertRunActive();
    const iterNum = await this.state.incrementIteration();
    console.log(`Iteration ${iterNum} / ${config.maxIterations}`);
    await this.state.clearEvidence();
    await this.state.clearVerdicts(iterNum);
    await this.state.clearReviews();
    const currentRun = await this.state.loadRun();
    if (!currentRun) {
      throw new CancelledError('Run was cancelled and archived', true);
    }
    let specContent;
    try {
      specContent = await fs2.readFile(currentRun.spec, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${currentRun.spec}
Run 'dev-loop init' to create it.`);
    }
    const iterData = buildIterationData(currentRun, config, currentRun.spec, specContent);
    await this.assertRunActive();
    await this.state.updatePhase('implementing');
    const implResult = await this.agentRunner.runImplementer({
      runId: run.id,
      iteration: iterNum,
      dirHash,
      prompt: iterData.implementerPrompt,
      timeout: config.implementerTimeout,
    });
    if (implResult.timedOut) {
      throw new Error('Implementer timed out');
    }
    await this.assertRunActive();
    const learnings = await this.state.readLearnings();
    if (learnings) {
      await this.state.addLearning(learnings);
    }
    await this.state.updatePhase('reviewing');
    const reviewerResults = await this.agentRunner.runReviewers({
      runId: run.id,
      iteration: iterNum,
      dirHash,
      prompts: iterData.reviewerPrompts,
      timeout: config.reviewerTimeout,
    });
    await this.assertRunActive();
    await this.state.updatePhase('done');
    const verdicts = reviewerResults.map(r => ({
      reviewerIndex: r.reviewerIndex,
      verdict: r.verdict,
      binary: r.binary,
    }));
    const consensusResult = checkConsensus(verdicts);
    console.log(`Consensus: ${formatConsensusResult(consensusResult)}`);
    const estimates = reviewerResults.map(r => r.completionEstimate).filter(e => e !== undefined);
    if (estimates.length > 0) {
      const lowestEstimate = Math.min(...estimates);
      const lowestEstimateReviewer = reviewerResults.find(r => r.completionEstimate === lowestEstimate);
      const reviewerInfo = lowestEstimateReviewer ? ` (Reviewer ${lowestEstimateReviewer.reviewerIndex})` : '';
      const barWidth = 40;
      const filled = Math.round((lowestEstimate / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
      console.log(`Progress: [${bar}] ${lowestEstimate}%${reviewerInfo}`);
    }
    return {
      iteration: iterNum,
      approved: consensusResult.approved,
      implementerResult: implResult,
      reviewerResults,
    };
  }
}

// modules/dev-loop-ts/src/agents/runner.ts
import * as fs3 from 'fs/promises';
import * as path2 from 'path';

// modules/dev-loop-ts/src/agents/verdicts.ts
function parseVerdictFile2(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.verdict === 'approved' || parsed.verdict === 'rejected') {
      return {
        verdict: parsed.verdict,
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
function determineVerdict(params) {
  const { verdictFileContent, reviewFileContent, exitCode, timedOut } = params;
  if (timedOut) {
    return 'rejected';
  }
  if (exitCode !== 0) {
    return 'rejected';
  }
  if (verdictFileContent) {
    const parsed = parseVerdictFile2(verdictFileContent);
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
  return 'rejected';
}

// modules/dev-loop-ts/src/agents/runner.ts
var LOGS_BASE_DIR = '.kagent/logs';

class AgentRunner {
  tmux;
  state;
  implementerBinary;
  reviewerBinaries;
  constructor(tmux, state, implementerBinary = 'claude', reviewerBinaries = ['claude-reviewer-zai']) {
    this.tmux = tmux;
    this.state = state;
    this.implementerBinary = implementerBinary;
    this.reviewerBinaries = reviewerBinaries;
  }
  getLogsDir(runId) {
    return path2.join(LOGS_BASE_DIR, runId);
  }
  async ensureLogsDir(runId) {
    await fs3.mkdir(this.getLogsDir(runId), { recursive: true });
  }
  getLogPath(runId, type, iteration, reviewerIndex) {
    const logsDir = this.getLogsDir(runId);
    if (type === 'rev' && reviewerIndex !== undefined) {
      return path2.join(logsDir, `rev-${iteration}-${reviewerIndex}.log`);
    }
    return path2.join(logsDir, `impl-${iteration}.log`);
  }
  async runImplementer(params) {
    const { runId, iteration, dirHash, prompt, timeout } = params;
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-impl`;
    const session = {
      id: sessionId,
      iteration,
      role: 'implementer',
      binary: this.implementerBinary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await this.state.saveSession(session);
    const promptFile = await this.writePromptFile(sessionId, prompt);
    await this.ensureLogsDir(runId);
    const logFile = this.getLogPath(runId, 'impl', iteration);
    const command = `cat "${promptFile}" | ${this.implementerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | dev-loop stream`;
    console.log(`Implementing in tmux: ${tmuxSession} (log: ${logFile})`);
    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    await this.state.saveSession(session);
    await this.cleanupPromptFile(promptFile);
    const learnings = await this.state.readLearnings();
    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      learnings,
    };
  }
  async runReviewers(params) {
    const { runId, iteration, dirHash, prompts, timeout } = params;
    console.log(`Running ${prompts.length} reviewers in parallel`);
    const results = await Promise.all(
      prompts.map(p =>
        this.runReviewer({
          runId,
          iteration,
          dirHash,
          reviewerIndex: p.reviewerIndex,
          prompt: p.prompt,
          timeout,
        }),
      ),
    );
    const approved = results.filter(r => r.verdict === 'approved').length;
    const rejected = results.filter(r => r.verdict === 'rejected').length;
    console.log(`Verdicts: ${approved} approved, ${rejected} rejected`);
    return results;
  }
  async runReviewer(params) {
    const { runId, iteration, dirHash, reviewerIndex, prompt, timeout } = params;
    const sessionId = generateId();
    const tmuxSession = `devloop-${dirHash}-${runId}-${iteration}-rev-${reviewerIndex}`;
    const reviewerBinary = this.reviewerBinaries[reviewerIndex % this.reviewerBinaries.length];
    const session = {
      id: sessionId,
      iteration,
      role: 'reviewer',
      reviewerIndex,
      binary: reviewerBinary,
      tmuxSession,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await this.state.saveSession(session);
    const promptFile = await this.writePromptFile(sessionId, prompt);
    await this.ensureLogsDir(runId);
    const logFile = this.getLogPath(runId, 'rev', iteration, reviewerIndex);
    const command = `cat "${promptFile}" | ${reviewerBinary} --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | dev-loop stream`;
    console.log(`  Reviewer ${reviewerIndex} (${reviewerBinary}) in tmux: ${tmuxSession} (log: ${logFile})`);
    const result = await this.tmux.runInSession({
      sessionName: tmuxSession,
      command,
      cwd: process.cwd(),
      timeoutMins: timeout,
    });
    const verdictPath = `.kagent/current/verdicts/${iteration}-${reviewerIndex}.json`;
    const verdictContent = await this.safeReadFile(verdictPath);
    const reviewPath = `.kagent/current/reviews/reviewer-${reviewerIndex}.md`;
    const reviewContent = await this.safeReadFile(reviewPath);
    const verdict = determineVerdict({
      verdictFileContent: verdictContent,
      reviewFileContent: reviewContent,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    let reasoning = '';
    let completionEstimate;
    if (verdictContent) {
      const parsed = parseVerdictFile2(verdictContent);
      reasoning = parsed.reasoning;
      completionEstimate = parsed.completionEstimate;
    }
    session.status = result.timedOut ? 'error' : 'completed';
    session.completedAt = new Date().toISOString();
    session.verdict = verdict;
    await this.state.saveSession(session);
    await this.copyReviewFiles(runId, iteration, reviewerIndex, reviewerBinary, reviewContent, verdictContent);
    await this.cleanupPromptFile(promptFile);
    const icon = verdict === 'approved' ? '\u2713' : '\u2717';
    console.log(
      `  ${icon} Reviewer ${reviewerIndex} (${reviewerBinary}): ${verdict}${completionEstimate !== undefined ? ` (${completionEstimate}%)` : ''}`,
    );
    return {
      sessionId,
      tmuxSession,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      reviewerIndex,
      binary: reviewerBinary,
      verdict,
      reasoning,
      completionEstimate,
    };
  }
  async writePromptFile(sessionId, prompt) {
    const tmpDir = '/tmp/dev-loop/prompts';
    await fs3.mkdir(tmpDir, { recursive: true });
    const promptFile = path2.join(tmpDir, `prompt-${sessionId}.txt`);
    await fs3.writeFile(promptFile, prompt, 'utf-8');
    return promptFile;
  }
  async cleanupPromptFile(promptFile) {
    try {
      await fs3.unlink(promptFile);
    } catch {}
  }
  async safeReadFile(filePath) {
    try {
      return await fs3.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
  async copyReviewFiles(runId, iteration, reviewerIndex, binary, reviewContent, verdictContent) {
    const reviewsDir = `.kagent/reviews/${runId}`;
    await fs3.mkdir(reviewsDir, { recursive: true });
    const binaryName = binary.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (reviewContent) {
      const reviewFile = path2.join(reviewsDir, `review-${iteration}-${reviewerIndex}-${binaryName}.md`);
      await fs3.writeFile(reviewFile, reviewContent, 'utf-8');
    }
    if (verdictContent) {
      const verdictFile = path2.join(reviewsDir, `verdict-${iteration}-${reviewerIndex}-${binaryName}.json`);
      await fs3.writeFile(verdictFile, verdictContent, 'utf-8');
    }
  }
}

// modules/dev-loop-ts/src/cli/run.ts
async function handler2(deps) {
  try {
    const available = await deps.tmux.isAvailable();
    if (!available) {
      console.error('Error: tmux is not installed');
      console.error('Install with: brew install tmux (macOS) or apt install tmux (Linux)');
      process.exit(1);
    }
    const hasConfig = await deps.state.hasConfig();
    if (!hasConfig) {
      console.error('Error: dev-loop not initialized');
      console.error('Run: dev-loop init');
      process.exit(1);
    }
    const config = await deps.state.loadConfig();
    const agentRunner = new AgentRunner(deps.tmux, deps.state, config.implementer, config.reviewers);
    const loopRunner = new LoopRunner(deps.state, deps.tmux, agentRunner);
    const result = await loopRunner.run();
    console.log('');
    console.log(`Loop finished: ${result.status}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// modules/dev-loop-ts/src/cli/status.ts
var import_picocolors = __toESM(require_picocolors(), 1);

// modules/dev-loop-ts/node_modules/date-fns/constants.js
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

// modules/dev-loop-ts/node_modules/date-fns/constructFrom.js
function constructFrom(date, value) {
  if (typeof date === 'function') return date(value);
  if (date && typeof date === 'object' && constructFromSymbol in date) return date[constructFromSymbol](value);
  if (date instanceof Date) return new date.constructor(value);
  return new Date(value);
}

// modules/dev-loop-ts/node_modules/date-fns/toDate.js
function toDate(argument, context) {
  return constructFrom(context || argument, argument);
}

// modules/dev-loop-ts/node_modules/date-fns/_lib/defaultOptions.js
var defaultOptions = {};
function getDefaultOptions() {
  return defaultOptions;
}

// modules/dev-loop-ts/node_modules/date-fns/startOfWeek.js
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

// modules/dev-loop-ts/node_modules/date-fns/startOfISOWeek.js
function startOfISOWeek(date, options) {
  return startOfWeek(date, { ...options, weekStartsOn: 1 });
}

// modules/dev-loop-ts/node_modules/date-fns/getISOWeekYear.js
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

// modules/dev-loop-ts/node_modules/date-fns/_lib/getTimezoneOffsetInMilliseconds.js
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

// modules/dev-loop-ts/node_modules/date-fns/_lib/normalizeDates.js
function normalizeDates(context, ...dates) {
  const normalize = constructFrom.bind(null, context || dates.find(date => typeof date === 'object'));
  return dates.map(normalize);
}

// modules/dev-loop-ts/node_modules/date-fns/startOfDay.js
function startOfDay(date, options) {
  const _date = toDate(date, options?.in);
  _date.setHours(0, 0, 0, 0);
  return _date;
}

// modules/dev-loop-ts/node_modules/date-fns/differenceInCalendarDays.js
function differenceInCalendarDays(laterDate, earlierDate, options) {
  const [laterDate_, earlierDate_] = normalizeDates(options?.in, laterDate, earlierDate);
  const laterStartOfDay = startOfDay(laterDate_);
  const earlierStartOfDay = startOfDay(earlierDate_);
  const laterTimestamp = +laterStartOfDay - getTimezoneOffsetInMilliseconds(laterStartOfDay);
  const earlierTimestamp = +earlierStartOfDay - getTimezoneOffsetInMilliseconds(earlierStartOfDay);
  return Math.round((laterTimestamp - earlierTimestamp) / millisecondsInDay);
}

// modules/dev-loop-ts/node_modules/date-fns/startOfISOWeekYear.js
function startOfISOWeekYear(date, options) {
  const year = getISOWeekYear(date, options);
  const fourthOfJanuary = constructFrom(options?.in || date, 0);
  fourthOfJanuary.setFullYear(year, 0, 4);
  fourthOfJanuary.setHours(0, 0, 0, 0);
  return startOfISOWeek(fourthOfJanuary);
}

// modules/dev-loop-ts/node_modules/date-fns/isDate.js
function isDate(value) {
  return (
    value instanceof Date || (typeof value === 'object' && Object.prototype.toString.call(value) === '[object Date]')
  );
}

// modules/dev-loop-ts/node_modules/date-fns/isValid.js
function isValid2(date) {
  return !((!isDate(date) && typeof date !== 'number') || isNaN(+toDate(date)));
}

// modules/dev-loop-ts/node_modules/date-fns/startOfYear.js
function startOfYear(date, options) {
  const date_ = toDate(date, options?.in);
  date_.setFullYear(date_.getFullYear(), 0, 1);
  date_.setHours(0, 0, 0, 0);
  return date_;
}

// modules/dev-loop-ts/node_modules/date-fns/locale/en-US/_lib/formatDistance.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/_lib/buildFormatLongFn.js
function buildFormatLongFn(args) {
  return (options = {}) => {
    const width = options.width ? String(options.width) : args.defaultWidth;
    const format = args.formats[width] || args.formats[args.defaultWidth];
    return format;
  };
}

// modules/dev-loop-ts/node_modules/date-fns/locale/en-US/_lib/formatLong.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/en-US/_lib/formatRelative.js
var formatRelativeLocale = {
  lastWeek: "'last' eeee 'at' p",
  yesterday: "'yesterday at' p",
  today: "'today at' p",
  tomorrow: "'tomorrow at' p",
  nextWeek: "eeee 'at' p",
  other: 'P',
};
var formatRelative = (token, _date, _baseDate, _options) => formatRelativeLocale[token];

// modules/dev-loop-ts/node_modules/date-fns/locale/_lib/buildLocalizeFn.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/en-US/_lib/localize.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/_lib/buildMatchFn.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/_lib/buildMatchPatternFn.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/en-US/_lib/match.js
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

// modules/dev-loop-ts/node_modules/date-fns/locale/en-US.js
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
// modules/dev-loop-ts/node_modules/date-fns/getDayOfYear.js
function getDayOfYear(date, options) {
  const _date = toDate(date, options?.in);
  const diff = differenceInCalendarDays(_date, startOfYear(_date));
  const dayOfYear = diff + 1;
  return dayOfYear;
}

// modules/dev-loop-ts/node_modules/date-fns/getISOWeek.js
function getISOWeek(date, options) {
  const _date = toDate(date, options?.in);
  const diff = +startOfISOWeek(_date) - +startOfISOWeekYear(_date);
  return Math.round(diff / millisecondsInWeek) + 1;
}

// modules/dev-loop-ts/node_modules/date-fns/getWeekYear.js
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

// modules/dev-loop-ts/node_modules/date-fns/startOfWeekYear.js
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

// modules/dev-loop-ts/node_modules/date-fns/getWeek.js
function getWeek(date, options) {
  const _date = toDate(date, options?.in);
  const diff = +startOfWeek(_date, options) - +startOfWeekYear(_date, options);
  return Math.round(diff / millisecondsInWeek) + 1;
}

// modules/dev-loop-ts/node_modules/date-fns/_lib/addLeadingZeros.js
function addLeadingZeros(number, targetLength) {
  const sign = number < 0 ? '-' : '';
  const output = Math.abs(number).toString().padStart(targetLength, '0');
  return sign + output;
}

// modules/dev-loop-ts/node_modules/date-fns/_lib/format/lightFormatters.js
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

// modules/dev-loop-ts/node_modules/date-fns/_lib/format/formatters.js
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

// modules/dev-loop-ts/node_modules/date-fns/_lib/format/longFormatters.js
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

// modules/dev-loop-ts/node_modules/date-fns/_lib/protectedTokens.js
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

// modules/dev-loop-ts/node_modules/date-fns/format.js
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

// modules/dev-loop-ts/src/cli/status.ts
async function handler3(state) {
  try {
    const hasConfig = await state.hasConfig();
    if (!hasConfig) {
      console.log(import_picocolors.default.yellow('Dev-loop not initialized.'));
      console.log(import_picocolors.default.dim('Run: dev-loop init'));
      return;
    }
    const config = await state.loadConfig();
    const run = await state.loadRun();
    console.log(import_picocolors.default.bold('Dev Loop Status'));
    console.log('');
    console.log(import_picocolors.default.cyan('Config:'));
    console.log(`  Implementer: ${config.implementer}`);
    console.log(`  Reviewers: ${config.reviewers.join(', ')}`);
    console.log(`  Max iterations: ${config.maxIterations}`);
    console.log(`  Timeouts: impl ${config.implementerTimeout}m, rev ${config.reviewerTimeout}m`);
    console.log('');
    if (!run) {
      console.log(import_picocolors.default.yellow('No active run.'));
      console.log(import_picocolors.default.dim('Run: dev-loop run'));
      return;
    }
    const statusColor =
      run.status === 'running'
        ? import_picocolors.default.green
        : run.status === 'completed'
          ? import_picocolors.default.blue
          : import_picocolors.default.yellow;
    console.log(`${import_picocolors.default.cyan('Run:')} ${run.id} ${statusColor(`[${run.status.toUpperCase()}]`)}`);
    console.log(`  Iteration: ${run.iteration} / ${config.maxIterations}`);
    console.log(`  Phase: ${run.phase}`);
    console.log(`  Started: ${format(new Date(run.startedAt), 'yyyy-MM-dd HH:mm:ss')}`);
    console.log('');
    if (run.learnings.length > 0) {
      console.log(import_picocolors.default.cyan(`Learnings (${run.learnings.length}):`));
      run.learnings.slice(-3).forEach((l, i) => {
        console.log(`  ${import_picocolors.default.dim(`${i + 1}.`)} ${l.slice(0, 60)}...`);
      });
      console.log('');
    }
    const sessions = await state.loadSessions();
    if (sessions.length > 0) {
      const currentIterSessions = sessions.filter(s => s.iteration === run.iteration);
      if (currentIterSessions.length > 0) {
        console.log(import_picocolors.default.cyan('Current Sessions:'));
        for (const s of currentIterSessions) {
          const status =
            s.status === 'running'
              ? import_picocolors.default.yellow('\u25CF')
              : s.status === 'completed'
                ? import_picocolors.default.green('\u2713')
                : import_picocolors.default.red('\u2717');
          const role = s.role === 'implementer' ? '\uD83D\uDD28 impl' : `\uD83D\uDD0D rev${s.reviewerIndex ?? ''}`;
          const binary = s.binary ? import_picocolors.default.dim(` (${s.binary})`) : '';
          const verdict = s.verdict
            ? s.verdict === 'approved'
              ? import_picocolors.default.green(' \u2713')
              : import_picocolors.default.red(' \u2717')
            : '';
          console.log(`  ${status} ${role}${binary}${verdict} ${import_picocolors.default.dim(s.tmuxSession)}`);
        }
        console.log('');
      }
    }
    console.log(import_picocolors.default.dim('Commands: dev-loop attach | dev-loop cancel | dev-loop logs'));
  } catch (err) {
    console.error(import_picocolors.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// modules/dev-loop-ts/node_modules/@clack/core/dist/index.mjs
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

// modules/dev-loop-ts/node_modules/@clack/prompts/dist/index.mjs
var import_picocolors2 = __toESM(require_picocolors(), 1);
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
      return import_picocolors2.default.cyan(le);
    case 'cancel':
      return import_picocolors2.default.red(L2);
    case 'error':
      return import_picocolors2.default.yellow(W2);
    case 'submit':
      return import_picocolors2.default.green(C);
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
    return j2 || E ? import_picocolors2.default.dim('...') : i(p2, v + l2 === n);
  });
};
var ve = t => {
  const n = (r2, i) => {
    const s = r2.label ?? String(r2.value);
    switch (i) {
      case 'selected':
        return `${import_picocolors2.default.dim(s)}`;
      case 'active':
        return `${import_picocolors2.default.green(k2)} ${s} ${r2.hint ? import_picocolors2.default.dim(`(${r2.hint})`) : ''}`;
      case 'cancelled':
        return `${import_picocolors2.default.strikethrough(import_picocolors2.default.dim(s))}`;
      default:
        return `${import_picocolors2.default.dim(P2)} ${import_picocolors2.default.dim(s)}`;
    }
  };
  return new LD({
    options: t.options,
    initialValue: t.initialValue,
    render() {
      const r2 = `${import_picocolors2.default.gray(o)}
${b2(this.state)}  ${t.message}
`;
      switch (this.state) {
        case 'submit':
          return `${r2}${import_picocolors2.default.gray(o)}  ${n(this.options[this.cursor], 'selected')}`;
        case 'cancel':
          return `${r2}${import_picocolors2.default.gray(o)}  ${n(this.options[this.cursor], 'cancelled')}
${import_picocolors2.default.gray(o)}`;
        default:
          return `${r2}${import_picocolors2.default.cyan(o)}  ${G2({
            cursor: this.cursor,
            options: this.options,
            maxItems: t.maxItems,
            style: (i, s) => n(i, s ? 'active' : 'inactive'),
          }).join(`
${import_picocolors2.default.cyan(o)}  `)}
${import_picocolors2.default.cyan(d2)}
`;
      }
    },
  }).prompt();
};
var xe = (t = '') => {
  process.stdout.write(`${import_picocolors2.default.gray(d2)}  ${import_picocolors2.default.red(t)}

`);
};
var Ie = (t = '') => {
  process.stdout.write(`${import_picocolors2.default.gray(ue)}  ${t}
`);
};
var Se = (t = '') => {
  process.stdout.write(`${import_picocolors2.default.gray(o)}
${import_picocolors2.default.gray(d2)}  ${t}

`);
};
var J2 = `${import_picocolors2.default.gray(o)}  `;

// modules/dev-loop-ts/src/cli/attach.ts
var import_picocolors3 = __toESM(require_picocolors(), 1);

// modules/dev-loop-ts/src/tmux/commands.ts
function generateSessionName(params) {
  const { dirHash, runId, iteration, role, reviewerIndex } = params;
  if (role === 'rev' && reviewerIndex !== undefined) {
    return `devloop-${dirHash}-${runId}-${iteration}-rev-${reviewerIndex}`;
  }
  return `devloop-${dirHash}-${runId}-${iteration}-${role}`;
}
function parseSessionName(sessionName) {
  const prefix = 'devloop-';
  if (!sessionName.startsWith(prefix)) {
    return null;
  }
  const withoutPrefix = sessionName.slice(prefix.length);
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
  return ['tmux', 'new-session', '-d', '-s', params.sessionName, '-c', params.cwd, 'sh', '-c', params.command];
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

// modules/dev-loop-ts/src/cli/attach.ts
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
async function handler4(tmux) {
  try {
    const sessions = await tmux.listSessions();
    if (sessions.length === 0) {
      console.log(import_picocolors3.default.yellow('No running agent sessions.'));
      return;
    }
    Ie(import_picocolors3.default.bgCyan(import_picocolors3.default.black(' Attach to Session ')));
    const choices = sessions.map(formatSessionChoice);
    const selected = await ve({
      message: 'Select a session to attach:',
      options: choices,
    });
    if (pD(selected)) {
      xe('Cancelled.');
      process.exit(0);
    }
    Se(`Attaching to ${import_picocolors3.default.cyan(selected)}...`);
    const { execSync } = await import('child_process');
    execSync(`tmux attach -t "${selected}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(import_picocolors3.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// modules/dev-loop-ts/src/cli/cancel.ts
async function handler5(state, tmux) {
  try {
    const run = await state.loadRun();
    let targetRunId = run?.id ?? null;
    if (!targetRunId) {
      const history = await state.listHistory();
      if (history.length === 0) {
        console.log('No active run to cancel.');
        return;
      }
      const latest = history[0];
      targetRunId = latest.id;
      console.log(`No active run found. Cleaning up latest run ${targetRunId}...`);
    } else {
      console.log(`Cancelling run ${targetRunId}...`);
      await state.cancelRun();
    }
    const sessions = await tmux.listSessions();
    let killed = 0;
    for (const session of sessions) {
      const parsed = tmux.parseSessionName(session);
      if (!parsed || parsed.runId !== targetRunId) continue;
      if (await tmux.killSession(session)) {
        killed++;
      }
    }
    if (killed > 0) {
      console.log(`Killed ${killed} tmux session(s)`);
    }
    if (run) {
      const stillActive = await state.loadRun();
      if (stillActive) {
        await state.completeRun('cancelled');
      }
      console.log('Run cancelled and archived.');
    } else {
      console.log('Cleanup complete.');
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// modules/dev-loop-ts/src/cli/history.ts
var import_picocolors4 = __toESM(require_picocolors(), 1);
async function listHandler(history, logs) {
  try {
    const entries = await history.list();
    if (entries.length === 0) {
      console.log(import_picocolors4.default.yellow('No run history found.'));
      return;
    }
    const runsWithLogs = logs ? new Set(await logs.listRuns()) : new Set();
    console.log(import_picocolors4.default.bold('Run History'));
    console.log('');
    for (const entry of entries) {
      const hasLogs = runsWithLogs.has(entry.id);
      const logsIndicator = hasLogs ? import_picocolors4.default.dim(' [logs]') : '';
      const status =
        entry.status === 'completed'
          ? import_picocolors4.default.green('\u2713')
          : entry.status === 'cancelled'
            ? import_picocolors4.default.yellow('\u25CB')
            : import_picocolors4.default.red('\u2717');
      console.log(
        `${status} ${entry.id}${logsIndicator} - ${entry.iterations} iter(s) - ${entry.startedAt.slice(0, 10)}`,
      );
    }
    console.log('');
    console.log(import_picocolors4.default.dim('Use "dev-loop history show <runId>" for details'));
    console.log(import_picocolors4.default.dim('Use "dev-loop logs" to view logs'));
  } catch (err) {
    console.error(import_picocolors4.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function showHandler(runId, history, logs) {
  try {
    const entry = await history.load(runId);
    if (!entry) {
      console.log(import_picocolors4.default.yellow(`Run ${runId} not found in history.`));
      return;
    }
    const runLogs = logs ? await logs.listLogs(runId) : [];
    const hasLogs = runLogs.length > 0;
    console.log(import_picocolors4.default.bold(`Run ${entry.id}`));
    console.log(`Status: ${entry.status}`);
    console.log(`Started: ${entry.startedAt}`);
    console.log(`Completed: ${entry.completedAt}`);
    console.log(`Iterations: ${entry.iterations}`);
    if (hasLogs) {
      console.log(`Logs: ${import_picocolors4.default.green(`${runLogs.length} file(s) available`)}`);
    }
    console.log('');
    console.log(import_picocolors4.default.cyan('Iterations:'));
    for (const iter of entry.summary) {
      console.log(`  #${iter.iteration}:`);
      if (iter.implementerDuration) {
        console.log(`    Duration: ${Math.round(iter.implementerDuration / 1000)}s`);
      }
      console.log(`    Verdicts:`);
      for (const v of iter.reviewerVerdicts) {
        const icon =
          v.verdict === 'approved'
            ? import_picocolors4.default.green('\u2713')
            : import_picocolors4.default.red('\u2717');
        const binaryLabel = v.binary ? import_picocolors4.default.dim(` (${v.binary})`) : '';
        console.log(`      ${icon} reviewer ${v.index}${binaryLabel}`);
      }
      if (iter.learnings.length > 0) {
        console.log(`    Learnings: ${iter.learnings.join('; ')}`);
      }
    }
    if (hasLogs) {
      console.log('');
      console.log(import_picocolors4.default.dim(`View logs: dev-loop logs`));
    }
  } catch (err) {
    console.error(import_picocolors4.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function clearHandler(history) {
  try {
    await history.clear();
    console.log(import_picocolors4.default.green('History cleared.'));
    console.log(import_picocolors4.default.dim('Note: Logs are preserved. Use "dev-loop logs clear" to remove logs.'));
  } catch (err) {
    console.error(import_picocolors4.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// modules/dev-loop-ts/src/cli/logs.ts
var import_picocolors5 = __toESM(require_picocolors(), 1);
function formatLogLabel(log) {
  if (log.role === 'impl') {
    return `Iteration ${log.iteration} - \uD83D\uDD28 Implementer`;
  }
  return `Iteration ${log.iteration} - \uD83D\uDD0D Reviewer ${log.reviewerIndex ?? 0}`;
}
function formatLogChoice(log, showRunId = false) {
  const label = showRunId ? `[${log.runId}] ${formatLogLabel(log)}` : formatLogLabel(log);
  return {
    value: log,
    label,
    hint: log.name,
  };
}
async function listHandler2(logs) {
  try {
    const runLogs = await logs.listLogsByRun();
    if (runLogs.length === 0) {
      console.log(import_picocolors5.default.yellow('No logs available yet.'));
      return;
    }
    const currentRunId = await logs.getCurrentRunId();
    console.log(import_picocolors5.default.bold('Available Logs'));
    console.log('');
    for (const { runId, logs: logFiles } of runLogs) {
      const isCurrent = runId === currentRunId;
      const runLabel = isCurrent
        ? import_picocolors5.default.green(`Run ${runId} (current)`)
        : import_picocolors5.default.cyan(`Run ${runId}`);
      console.log(runLabel);
      for (const log of logFiles) {
        const role = log.role === 'impl' ? '\uD83D\uDD28 impl' : `\uD83D\uDD0D rev${log.reviewerIndex ?? ''}`;
        console.log(`  ${role} iter ${log.iteration} ${import_picocolors5.default.dim(log.name)}`);
      }
      console.log('');
    }
  } catch (err) {
    console.error(import_picocolors5.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function viewHandler(logName, logs) {
  try {
    const currentRunId = await logs.getCurrentRunId();
    let logFiles = [];
    if (currentRunId) {
      logFiles = await logs.listLogs(currentRunId);
    }
    let log = logFiles.find(l2 => l2.name === logName || l2.name === `${logName}.log`);
    if (!log) {
      logFiles = await logs.listLogs();
      log = logFiles.find(l2 => l2.name === logName || l2.name === `${logName}.log`);
    }
    if (!log) {
      console.log(import_picocolors5.default.yellow(`Log "${logName}" not found.`));
      console.log('Use "dev-loop logs list" to see available logs.');
      return;
    }
    console.log(import_picocolors5.default.dim(`Reading: ${log.path}`));
    console.log('');
    const content = await logs.readLog(log.path);
    displayFormattedLog(content);
  } catch (err) {
    console.error(import_picocolors5.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function interactiveHandler(logs) {
  try {
    const runLogs = await logs.listLogsByRun();
    if (runLogs.length === 0) {
      console.log(import_picocolors5.default.yellow('No logs available yet.'));
      return;
    }
    Ie(import_picocolors5.default.bgMagenta(import_picocolors5.default.black(' View Logs ')));
    const currentRunId = await logs.getCurrentRunId();
    let selectedRunId;
    if (runLogs.length === 1) {
      selectedRunId = runLogs[0].runId;
    } else {
      const runChoices = runLogs.map(({ runId, logs: logFiles2 }) => {
        const isCurrent = runId === currentRunId;
        const label = isCurrent ? `${runId} (current)` : runId;
        return {
          value: runId,
          label,
          hint: `${logFiles2.length} log(s)`,
        };
      });
      const selected = await ve({
        message: 'Select a run:',
        options: runChoices,
      });
      if (pD(selected)) {
        xe('Cancelled.');
        process.exit(0);
      }
      selectedRunId = selected;
    }
    const logFiles = await logs.listLogs(selectedRunId);
    const choices = logFiles.map(log2 => formatLogChoice(log2, false));
    const selectedLog = await ve({
      message: `Select a log from run ${selectedRunId}:`,
      options: choices,
    });
    if (pD(selectedLog)) {
      xe('Cancelled.');
      process.exit(0);
    }
    const log = selectedLog;
    Se(`Viewing ${import_picocolors5.default.cyan(log.name)}`);
    console.log('');
    const content = await logs.readLog(log.path);
    displayFormattedLog(content);
  } catch (err) {
    console.error(import_picocolors5.default.red(`Error: ${err.message}`));
    process.exit(1);
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
      console.log(import_picocolors5.default.dim(`[${entry.type}]`));
  }
}
function formatSystemEntry(entry) {
  if (entry.subtype === 'init') {
    console.log(
      import_picocolors5.default.yellow(
        '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      ),
    );
    console.log(import_picocolors5.default.yellow(`  SESSION START`));
    if (entry.cwd) console.log(import_picocolors5.default.dim(`  cwd: ${entry.cwd}`));
    if (entry.session_id) console.log(import_picocolors5.default.dim(`  session: ${entry.session_id}`));
    console.log(
      import_picocolors5.default.yellow(
        '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      ),
    );
    console.log('');
  } else if (typeof entry.message === 'string') {
    console.log(import_picocolors5.default.yellow(`[system] ${entry.message}`));
  }
}
function formatAssistantEntry(entry) {
  const message2 = entry.message;
  if (!message2?.content) return;
  for (const block of message2.content) {
    if (block.type === 'text' && block.text) {
      console.log('');
      console.log(
        import_picocolors5.default.green(
          '\u250C\u2500 CLAUDE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
        ),
      );
      for (const line of block.text.split(`
`)) {
        console.log(import_picocolors5.default.green('\u2502 ') + line);
      }
      console.log(
        import_picocolors5.default.green(
          '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
        ),
      );
    } else if (block.type === 'tool_use' && block.name) {
      console.log('');
      console.log(import_picocolors5.default.blue(`  \u26A1 ${block.name}`));
      if (block.input) {
        const formatted = formatToolInput(block.name, block.input);
        for (const line of formatted.split(`
`)) {
          console.log(import_picocolors5.default.dim(`     ${line}`));
        }
      }
    }
  }
}
function formatUserEntry(entry) {
  const message2 = entry.message;
  if (!message2?.content) return;
  for (const block of message2.content) {
    if (block.type === 'tool_result') {
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
        console.log(import_picocolors5.default.dim(`     \u21B3 ${filePath}`));
      }
      for (const line of displayLines) {
        const cleanLine = line.replace(/^\s*\d+\u2192/, '');
        const truncatedLine = cleanLine.length > 100 ? cleanLine.slice(0, 100) + '...' : cleanLine;
        console.log(import_picocolors5.default.dim(`     \u2502 ${truncatedLine}`));
      }
      if (truncated) {
        console.log(import_picocolors5.default.dim(`     \u2502 ... (${lines.length - maxLines} more lines)`));
      }
    }
  }
}
function formatFinalResult(entry) {
  console.log('');
  console.log(
    import_picocolors5.default.magenta(
      '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    ),
  );
  console.log(import_picocolors5.default.magenta('  SESSION COMPLETE'));
  console.log(
    import_picocolors5.default.magenta(
      '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    ),
  );
  if (entry.duration_ms) {
    const mins = Math.floor(entry.duration_ms / 60000);
    const secs = Math.floor((entry.duration_ms % 60000) / 1000);
    console.log(import_picocolors5.default.dim(`  Duration: ${mins}m ${secs}s`));
  }
  if (entry.num_turns) {
    console.log(import_picocolors5.default.dim(`  Turns: ${entry.num_turns}`));
  }
  if (entry.total_cost_usd) {
    console.log(import_picocolors5.default.dim(`  Cost: $${entry.total_cost_usd.toFixed(2)}`));
  }
  if (entry.result) {
    console.log('');
    console.log(import_picocolors5.default.white('  Result:'));
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
    default:
      const json = JSON.stringify(input);
      return json.length > 200 ? json.slice(0, 200) + '...' : json;
  }
}
function truncateMultiline(str, maxLen) {
  if (!str) return '';
  const single = str.replace(/\n/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return single.slice(0, maxLen) + '...';
}
async function clearHandler2(logs, runId) {
  try {
    const runs = await logs.listRuns();
    if (runs.length === 0) {
      console.log(import_picocolors5.default.yellow('No logs to clear.'));
      return;
    }
    if (runId) {
      if (!runs.includes(runId)) {
        console.log(import_picocolors5.default.yellow(`Run "${runId}" not found.`));
        return;
      }
      await clearRunLogs(runId);
      console.log(import_picocolors5.default.green(`Cleared logs for run ${runId}`));
    } else {
      Ie(import_picocolors5.default.bgRed(import_picocolors5.default.white(' Clear Logs ')));
      const currentRunId = await logs.getCurrentRunId();
      const choices = [
        { value: 'all', label: 'All logs', hint: `${runs.length} run(s)` },
        ...runs.map(id => ({
          value: id,
          label: id === currentRunId ? `${id} (current)` : id,
        })),
      ];
      const selected = await ve({
        message: 'Select logs to clear:',
        options: choices,
      });
      if (pD(selected)) {
        xe('Cancelled.');
        process.exit(0);
      }
      if (selected === 'all') {
        for (const id of runs) {
          await clearRunLogs(id);
        }
        Se(import_picocolors5.default.green(`Cleared all logs (${runs.length} runs)`));
      } else {
        await clearRunLogs(selected);
        Se(import_picocolors5.default.green(`Cleared logs for run ${selected}`));
      }
    }
  } catch (err) {
    console.error(import_picocolors5.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
async function clearRunLogs(runId) {
  const fs4 = await import('fs/promises');
  const logsDir = `.kagent/logs/${runId}`;
  try {
    await fs4.rm(logsDir, { recursive: true });
  } catch {}
}

// modules/dev-loop-ts/src/cli/remove.ts
var import_picocolors6 = __toESM(require_picocolors(), 1);
async function handler6(state) {
  try {
    console.log('Removing dev-loop state (history preserved)...');
    await state.destroy();
    console.log(import_picocolors6.default.green('Done.'));
  } catch (err) {
    console.error(import_picocolors6.default.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

// modules/dev-loop-ts/src/stream/parse.ts
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
  const o2 = obj;
  if (o2.type === 'system' && typeof o2.message === 'string') {
    return { type: 'system', message: o2.message, timestamp: o2.timestamp };
  }
  if (o2.type === 'assistant' && o2.message) {
    return { type: 'assistant', message: o2.message };
  }
  if (o2.type === 'user' && o2.message) {
    return { type: 'user', message: o2.message };
  }
  if (o2.type === 'result' && o2.result) {
    return { type: 'result', result: o2.result };
  }
  if (o2.type === 'error' && o2.error) {
    return { type: 'error', error: o2.error };
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

// modules/dev-loop-ts/src/stream/format.ts
var import_picocolors7 = __toESM(require_picocolors(), 1);
function formatEvent(event) {
  switch (event.type) {
    case 'system':
      return import_picocolors7.default.dim(`[system] ${event.message}`);
    case 'user':
      return formatUserMessage(event.message.content);
    case 'assistant':
      return formatAssistantMessage(event.message.content);
    case 'result':
      return formatResult(event.result);
    case 'error':
      return import_picocolors7.default.red(`[error] ${event.error.message}`);
    case 'unknown':
      return null;
  }
}
function formatUserMessage(content) {
  const text = typeof content === 'string' ? content : extractText(content);
  const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
  return import_picocolors7.default.cyan(`\u25B6 ${truncated.replace(/\n/g, ' ')}`);
}
function formatAssistantMessage(content) {
  const parts = [];
  const text = extractText(content);
  if (text) {
    parts.push(text);
  }
  const tools = extractToolUses(content);
  for (const tool of tools) {
    parts.push(import_picocolors7.default.yellow(`[${tool.name}]`) + formatToolInput2(tool.input));
  }
  return parts.join(`
`);
}
function formatToolInput2(input) {
  if (!input || typeof input !== 'object') return '';
  const o2 = input;
  if ('command' in o2 && typeof o2.command === 'string') {
    return import_picocolors7.default.dim(` $ ${o2.command.slice(0, 80)}`);
  }
  if ('file_path' in o2 && typeof o2.file_path === 'string') {
    return import_picocolors7.default.dim(` ${o2.file_path}`);
  }
  if ('pattern' in o2 && typeof o2.pattern === 'string') {
    return import_picocolors7.default.dim(` ${o2.pattern}`);
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
  return import_picocolors7.default.dim(`[done] ${parts.join(' | ')}`);
}

// modules/dev-loop-ts/src/cli/stream.ts
async function handler7() {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk);
    const lines = buffer.split(`
`);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  }
  if (buffer.trim()) {
    processLine(buffer);
  }
}
function processLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const event = tryParseJson(trimmed);
  if (event) {
    const formatted = formatEvent(event);
    if (formatted) {
      console.log(formatted);
    }
  } else {
    console.log(line);
  }
}

// modules/dev-loop-ts/src/cli/index.ts
function createCli(deps) {
  const program2 = new Command()
    .name('dev-loop')
    .description('Spec-driven development with multi-reviewer consensus')
    .version('2.0.0');
  program2
    .command('init')
    .description('Initialize dev-loop configuration (spec + config)')
    .option('--implementer <binary>', 'implementer binary name', 'claude')
    .option('--reviewers <list>', 'reviewer binaries (comma-separated)', 'claude-reviewer-zai')
    .option('--max-iterations <n>', 'maximum iterations', '10')
    .option('--implementer-timeout <mins>', 'implementer timeout in minutes', '30')
    .option('--reviewer-timeout <mins>', 'reviewer timeout in minutes', '15')
    .action(async opts => handler(opts, deps.state));
  program2
    .command('run')
    .description('Start the dev loop')
    .action(async () => handler2(deps));
  program2
    .command('status')
    .description('Show current run state')
    .action(async () => handler3(deps.state));
  program2
    .command('attach')
    .description('Attach to a running tmux session')
    .action(async () => handler4(deps.tmux));
  program2
    .command('cancel')
    .description('Stop current run, kill tmux sessions')
    .action(async () => handler5(deps.state, deps.tmux));
  const historyGroup = program2.command('history').description('View run history');
  historyGroup
    .command('list')
    .alias('ls')
    .description('List past runs')
    .action(async () => listHandler(deps.history, deps.logs));
  historyGroup
    .command('show <runId>')
    .description('Show details of a run')
    .action(async runId => showHandler(runId, deps.history, deps.logs));
  historyGroup
    .command('clear')
    .description('Clear all history')
    .action(async () => clearHandler(deps.history));
  historyGroup.action(async () => listHandler(deps.history, deps.logs));
  const logsGroup = program2.command('logs').description('View agent logs');
  logsGroup
    .command('list')
    .alias('ls')
    .description('List all logs')
    .action(async () => listHandler2(deps.logs));
  logsGroup
    .command('view <logName>')
    .description('View a specific log (e.g., impl-1 or rev-1-0)')
    .action(async logName => viewHandler(logName, deps.logs));
  logsGroup
    .command('clear [runId]')
    .description('Clear logs (optionally for a specific run)')
    .action(async runId => clearHandler2(deps.logs, runId));
  logsGroup.action(async () => interactiveHandler(deps.logs));
  program2
    .command('remove')
    .description('Remove dev-loop state (preserves history)')
    .action(async () => handler6(deps.state));
  program2
    .command('stream')
    .description('Process streaming JSON from stdin (internal use)')
    .action(async () => handler7());
  return program2;
}

// modules/dev-loop-ts/src/state/service.ts
class StateService {
  fs;
  paths;
  constructor(fs4, paths2) {
    this.fs = fs4;
    this.paths = paths2;
  }
  async initProject(overrides = {}) {
    await this.fs.mkdir(this.paths.baseDir);
    await this.fs.mkdir(this.paths.historyDir);
    if (!(await this.fs.exists(this.paths.spec))) {
      await this.fs.writeFile(this.paths.spec, SPEC_TEMPLATE);
    }
    if (await this.fs.exists(this.paths.config)) {
      const existing = await this.loadConfig();
      await this.saveConfig({ ...existing, ...overrides });
    } else {
      await this.saveConfig(mergeConfig(overrides));
    }
  }
  async hasConfig() {
    return this.fs.exists(this.paths.config);
  }
  async loadConfig() {
    const content = await this.fs.readFile(this.paths.config);
    return parseConfig(JSON.parse(content));
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
  async addLearning(learning) {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.learnings.push(learning);
    await this.saveRun(run);
  }
  async completeRun(status) {
    const run = await this.loadRun();
    if (!run) throw new Error('No active run');
    run.status = status;
    run.phase = 'done';
    await this.saveRun(run);
    return await this.archiveRun();
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
  async saveVerdict(iteration, reviewerIndex, verdict) {
    await this.fs.writeJson(this.paths.verdictFile(iteration, reviewerIndex), verdict);
  }
  async loadVerdicts(iteration) {
    if (!(await this.fs.exists(this.paths.verdictsDir))) return new Map();
    const files = await this.fs.readdir(this.paths.verdictsDir);
    const pattern = new RegExp(`^${iteration}-(\\d+)\\.json$`);
    const verdicts = new Map();
    for (const file of files) {
      const match2 = file.match(pattern);
      if (match2) {
        const content = await this.fs.readFile(`${this.paths.verdictsDir}/${file}`);
        verdicts.set(parseInt(match2[1], 10), parseVerdictFile(JSON.parse(content)));
      }
    }
    return verdicts;
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
  async readLearnings() {
    if (!(await this.fs.exists(this.paths.learnings))) return null;
    return this.fs.readFile(this.paths.learnings);
  }
  async archiveRun() {
    const run = await this.loadRun();
    if (!run) throw new Error('No run to archive');
    const sessions = await this.loadSessions();
    const cfg = await this.loadConfig();
    const entry = {
      id: run.id,
      spec: run.spec,
      config: cfg,
      status: run.status,
      iterations: run.iteration,
      startedAt: run.startedAt,
      completedAt: getCurrentTimestamp(),
      summary: this.buildSummary(sessions, run.learnings),
    };
    await this.fs.writeJson(this.paths.historyEntry(run.id), entry);
    await this.fs.rm(this.paths.currentDir, { recursive: true });
    return entry;
  }
  buildSummary(sessions, learnings) {
    const byIteration = new Map();
    for (const s of sessions) {
      const list = byIteration.get(s.iteration) || [];
      list.push(s);
      byIteration.set(s.iteration, list);
    }
    return Array.from(byIteration.entries()).map(([iteration, iterSessions]) => {
      const impl = iterSessions.find(s => s.role === 'implementer');
      const reviewers = iterSessions.filter(s => s.role === 'reviewer');
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
      };
    });
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

// modules/dev-loop-ts/src/tmux/service.ts
import * as fs4 from 'fs/promises';
import * as path3 from 'path';
import * as os from 'os';
class TmuxServiceImpl {
  spawn;
  statusDir = path3.join(os.tmpdir(), 'dev-loop', 'status');
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
      .filter(s => s.startsWith('devloop-'));
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
      await fs4.unlink(statusFile);
    } catch {}
    await fs4.writeFile(statusFile, 'RUNNING', { mode: 384 });
    const wrappedCommand = `${buildTimeoutCommand(params.command, params.timeoutMins)}; echo $? > "${statusFile}"`;
    const cmd = buildNewSessionCommand({
      sessionName: params.sessionName,
      cwd: params.cwd,
      command: wrappedCommand,
    });
    const createProc = this.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
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
      const statusContent = await fs4.readFile(statusFile, 'utf-8');
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
      await fs4.unlink(statusFile);
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
    await fs4.mkdir(this.statusDir, { recursive: true, mode: 448 });
  }
  getStatusFilePath(sessionName) {
    const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path3.join(this.statusDir, `${safeName}.status`);
  }
}
function createTmuxService(spawn) {
  return new TmuxServiceImpl(spawn);
}

// modules/dev-loop-ts/src/history/format.ts
var import_picocolors8 = __toESM(require_picocolors(), 1);
function formatHistoryEntry(entry) {
  const lines = [];
  lines.push(import_picocolors8.default.bold(`Run: ${entry.id}`));
  lines.push(`  Status: ${formatStatus(entry.status)}`);
  lines.push(`  Iterations: ${entry.iterations}`);
  lines.push(`  Started: ${format(new Date(entry.startedAt), 'yyyy-MM-dd HH:mm:ss')}`);
  lines.push(`  Completed: ${format(new Date(entry.completedAt), 'yyyy-MM-dd HH:mm:ss')}`);
  lines.push('');
  for (const sum of entry.summary) {
    lines.push(`  Iteration ${sum.iteration}:`);
    lines.push(`    Duration: ${Math.round(sum.implementerDuration / 1000)}s`);
    const verdicts = sum.reviewerVerdicts
      .map(
        v =>
          `${v.verdict === 'approved' ? import_picocolors8.default.green('\u2713') : import_picocolors8.default.red('\u2717')}`,
      )
      .join(' ');
    lines.push(`    Verdicts: ${verdicts}`);
    if (sum.learnings.length > 0) {
      lines.push(`    Learnings: ${sum.learnings.length}`);
    }
  }
  return lines.join(`
`);
}
function formatHistoryList(entries) {
  if (entries.length === 0) {
    return 'No history entries.';
  }
  return entries.map(e2 => {
    const date = format(new Date(e2.startedAt), 'MM-dd HH:mm');
    const status = formatStatus(e2.status);
    return `${e2.id}  ${date}  ${status}  ${e2.iterations} iterations`;
  }).join(`
`);
}
function formatStatus(status) {
  switch (status) {
    case 'completed':
      return import_picocolors8.default.green('completed');
    case 'cancelled':
      return import_picocolors8.default.yellow('cancelled');
    case 'failed':
      return import_picocolors8.default.red('failed');
    default:
      return status;
  }
}

// modules/dev-loop-ts/src/history/service.ts
class HistoryServiceImpl {
  fs;
  paths;
  constructor(fs5, paths2) {
    this.fs = fs5;
    this.paths = paths2;
  }
  async list() {
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
  async load(runId) {
    const entryPath = this.paths.historyEntry(runId);
    if (!(await this.fs.exists(entryPath))) return null;
    try {
      const content = await this.fs.readFile(entryPath);
      return parseHistoryEntry(JSON.parse(content));
    } catch (err) {
      if (process.env.DEBUG) console.error(`Failed to load history ${runId}:`, err);
      return null;
    }
  }
  format(entry) {
    return formatHistoryEntry(entry);
  }
  formatList(entries) {
    return formatHistoryList(entries);
  }
  async clear() {
    if (!(await this.fs.exists(this.paths.historyDir))) return;
    const files = await this.fs.readdir(this.paths.historyDir);
    for (const file of files.filter(f => f.endsWith('.json'))) {
      await this.fs.unlink(`${this.paths.historyDir}/${file}`);
    }
  }
}
function createHistoryService(fs5, paths2) {
  return new HistoryServiceImpl(fs5, paths2);
}

// modules/dev-loop-ts/src/logs/service.ts
import * as path4 from 'path';

class LogsServiceImpl {
  fs;
  paths;
  constructor(fs5, paths2) {
    this.fs = fs5;
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
    if (!(await this.fs.exists(this.paths.logsDir))) {
      return [];
    }
    const entries = await this.fs.readdir(this.paths.logsDir);
    const runs = [];
    for (const entry of entries) {
      const entryPath = path4.join(this.paths.logsDir, entry);
      try {
        const files = await this.fs.readdir(entryPath);
        if (files.some(f => f.endsWith('.log'))) {
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
    const runLogsDir = this.paths.runLogsDir(runId);
    if (!(await this.fs.exists(runLogsDir))) {
      return [];
    }
    const files = await this.fs.readdir(runLogsDir);
    const logs = [];
    for (const file of files.filter(f => f.endsWith('.log'))) {
      const parsed = this.parseLogName(file);
      if (parsed) {
        logs.push({
          runId,
          name: file,
          path: path4.join(runLogsDir, file),
          ...parsed,
        });
      }
    }
    return logs.sort((a, b3) => {
      if (a.iteration !== b3.iteration) return a.iteration - b3.iteration;
      if (a.role !== b3.role) return a.role === 'impl' ? -1 : 1;
      return (a.reviewerIndex ?? 0) - (b3.reviewerIndex ?? 0);
    });
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
function createLogsService(fs5, paths2) {
  return new LogsServiceImpl(fs5, paths2);
}

// modules/dev-loop-ts/src/index.ts
var state = new StateService(defaultFsService, paths);
var tmux = createTmuxService();
var history = createHistoryService(defaultFsService, paths);
var logs = createLogsService(defaultFsService, paths);
var program2 = createCli({ state, tmux, history, logs });
program2.parse(process.argv);
