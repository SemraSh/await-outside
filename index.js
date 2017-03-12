const repl = require("repl");
const vm = require("vm");

// see https://github.com/nodejs/node/blob/master/lib/repl.js#L1371
function isRecoverableError(error) {
  if (error && error.name === "SyntaxError") {
    var message = error.message;
    if (
      message === "Unterminated template literal" ||
      message === "Missing } in template expression"
    ) {
      return true;
    }

    if (
      message.startsWith("Unexpected end of input") ||
      message.startsWith("missing ) after argument list") ||
      message.startsWith("Unexpected token")
    )
      return true;
  }
  return false;
}

function formatError(error, source) {
  if (
    !error.stack // promises can be rejected with non-error values
  )
    return error;

  const firstLineOfSource = "at repl:" + 0;
  const lastLineOfSource = "at repl:" + (source.split("\n").length - 1);

  let frames = error.stack.split("\n");

  frames = frames
    // remove __async invocation from stack
    .filter(l => !l.trim().startsWith(firstLineOfSource))
    // remove IIFE invocation from stack
    .filter(l => !l.trim().startsWith(lastLineOfSource))
    // remove any frames inside this file (ie. inside __async helper)
    .filter(l => !l.includes(__filename));

  error.stack = frames.join("\n");

  return error;
}

/*
- allow whitespace before everything else
- optionally capture `var|let|const <varname> = `
  - varname only matches if it starts with a-Z or _ or $
    and if contains only those chars or numbers
  - this is overly restrictive but is easier to maintain
- capture `await <anything that follows it>`
*/
let re = /^\s*((?:(?:var|const|let)\s+)?[a-zA-Z_$][0-9a-zA-Z_$]*\s*=\s*)?(\(?\s*await[\s\S]*)/;

function isAwaitOutside(source) {
  return re.test(source);
}

const RESULT = "__await_outside_result";

function wrapAwaitOutside(source) {
  const [_, assign, expression] = source.match(re);

  // strange indentation keeps column offset correct in stack traces
  const wrappedExpression = `(async function() { try { ${assign ? `global.${RESULT} =` : "return"} (
${expression.trim()}
); } catch(e) { global.ERROR = e; throw e; } }())`;

  const assignment = assign
    ? `${assign.trim()} global.${RESULT}; void delete global.${RESULT};`
    : null;

  return [wrappedExpression, assignment];
}

const engineSupportsAsyncFunctions = (function() {
  try {
    eval("(async function() { })");
    return true;
  } catch (e) {
    // add async-to-gen helper to global context
    const { asyncHelper: asyncHelperString } = require("async-to-gen");
    global.__async = Function(`return ${asyncHelperString}`)();
    return false;
  }
})();

function asyncToGenIfNecessary(source) {
  if (engineSupportsAsyncFunctions) return source;

  const asyncToGen = require("async-to-gen");
  return asyncToGen(source, { includeHelper: false }).toString();
}

function addAwaitOutsideToReplServer(replServer) {
  replServer.eval = (function(originalEval) {
    return function(source, context, filename, cb) {
      if (!isAwaitOutside(source)) {
        return originalEval.call(this, source, context, filename, cb);
      }

      const [newSource, assignment] = wrapAwaitOutside(source);
      const options = { filename, displayErrors: true, lineOffset: -1 };
      const runOptions = { displayErrors: true, breakOnSigint: true };

      try {
        var transpiledSource = asyncToGenIfNecessary(newSource);
        var script = vm.createScript(transpiledSource, options);
      } catch (e) {
        cb(isRecoverableError(e) ? new repl.Recoverable(e) : e);
        return;
      }

      script
        .runInThisContext(runOptions)
        .then(
          r => cb(null, assignment ? vm.runInThisContext(assignment) : r),
          err => cb(formatError(err, transpiledSource))
        );
    };
  })(replServer.eval);
}

module.exports = {
  addAwaitOutsideToReplServer,
  wrapAwaitOutside,
  isAwaitOutside
};
