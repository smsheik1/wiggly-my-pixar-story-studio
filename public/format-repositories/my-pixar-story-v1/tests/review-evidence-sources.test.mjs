import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReviewQuotes } from '../runtime/crew.mjs';

const T = { timeout: 20000 };

const review = quote => ({
  decision: 'approved',
  checks: [{
    criterion: 'facts',
    status: 'pass',
    evidence: 'verifiable evidence quote',
    location: 'whole deliverable',
    quotes: [quote]
  }]
});

test('a quote from task.lockedAnswers (approved) passes', T, async () => {
  const quote = 'when i was 8 years old, i wanted to be a scientist';
  const task = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    lockedAnswers: {
      id: 'answers@1',
      valid: true,
      approvedBy: { message: 'approved by human', at: '2026-10-11T00:00:00Z' },
      content: {
        inputs: {
          answers: {
            scene1Childhood: {
              memory: quote
            }
          }
        }
      }
    }
  };
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'text-reviewer', task, review: review(quote), outputs: new Map() }));
});

test('a quote from task.inputs.answers passes', T, async () => {
  const quote = 'when i was 8 years old, i wanted to be a scientist';
  const task = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    inputs: {
      answers: {
        scene1Childhood: {
          memory: quote
        }
      }
    }
  };
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'text-reviewer', task, review: review(quote), outputs: new Map() }));
});

test('a quote from task.creativeDirections passes', T, async () => {
  const quote = 'Use one shared late-teen character design for Shaz at story ages 17 and 19.';
  const task = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    creativeDirections: [{
      scope: 'cast',
      direction: quote,
      sourceMessages: ['message 1']
    }]
  };
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'text-reviewer', task, review: review(quote), outputs: new Map() }));
});

test('a quote from an approved task.shotIntentions passes', T, async () => {
  const quote = 'Shaz stands screen-left and his mother sits screen-right';
  const task = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    shotIntentions: {
      id: 'shotIntentions@1',
      valid: true,
      approvedBy: { message: 'approved shot plan', at: '2026-10-11T00:00:00Z' },
      content: {
        shots: [{
          id: 'shot-1',
          staging: quote
        }]
      }
    }
  };
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'text-reviewer', task, review: review(quote), outputs: new Map() }));
});

test('a quote from a signed bible passes', T, async () => {
  const quote = 'always wears the green work apron with a brass bell pin';
  const task = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    productionBible: {
      status: 'signed',
      version: 1,
      sections: {
        cast: quote
      }
    }
  };
  assert.doesNotThrow(() => verifyReviewQuotes({ role: 'text-reviewer', task, review: review(quote), outputs: new Map() }));
});

test('the same quote from an UNAPPROVED/draft shotIntentions or answers artifact is rejected', T, async () => {
  const shotQuote = 'Shaz stands screen-left and his mother sits screen-right';
  const draftShots = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    shotIntentions: {
      id: 'shotIntentions@1',
      valid: true,
      content: {
        shots: [{ id: 'shot-1', staging: shotQuote }]
      }
    }
  };
  assert.throws(
    () => verifyReviewQuotes({ role: 'text-reviewer', task: draftShots, review: review(shotQuote), outputs: new Map() }),
    /REVIEW_QUOTE_NOT_FOUND/
  );

  const invalidShots = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    shotIntentions: {
      id: 'shotIntentions@1',
      valid: false,
      approvedBy: { message: 'approved', at: '2026-10-11T00:00:00Z' },
      content: {
        shots: [{ id: 'shot-1', staging: shotQuote }]
      }
    }
  };
  assert.throws(
    () => verifyReviewQuotes({ role: 'text-reviewer', task: invalidShots, review: review(shotQuote), outputs: new Map() }),
    /REVIEW_QUOTE_NOT_FOUND/
  );

  const ansQuote = 'when i was 8 years old, i wanted to be a scientist';
  const draftAnswers = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    lockedAnswers: {
      id: 'answers@1',
      valid: true,
      content: {
        inputs: {
          answers: {
            scene1Childhood: { memory: ansQuote }
          }
        }
      }
    }
  };
  assert.throws(
    () => verifyReviewQuotes({ role: 'text-reviewer', task: draftAnswers, review: review(ansQuote), outputs: new Map() }),
    /REVIEW_QUOTE_NOT_FOUND/
  );

  const invalidAnswers = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    lockedAnswers: {
      id: 'answers@1',
      valid: false,
      approvedBy: { message: 'approved', at: '2026-10-11T00:00:00Z' },
      content: {
        inputs: {
          answers: {
            scene1Childhood: { memory: ansQuote }
          }
        }
      }
    }
  };
  assert.throws(
    () => verifyReviewQuotes({ role: 'text-reviewer', task: invalidAnswers, review: review(ansQuote), outputs: new Map() }),
    /REVIEW_QUOTE_NOT_FOUND/
  );
});

test('a quote from an unsigned bible draft is rejected', T, async () => {
  const quote = 'always wears the green work apron with a brass bell pin';
  const task = {
    artifact: { content: { note: 'artifact text' } },
    dependencies: [],
    productionBible: {
      status: 'unsigned',
      version: 1,
      sections: {
        cast: quote
      }
    }
  };
  assert.throws(
    () => verifyReviewQuotes({ role: 'text-reviewer', task, review: review(quote), outputs: new Map() }),
    /REVIEW_QUOTE_NOT_FOUND/
  );
});

test('a fabricated quote is still rejected', T, async () => {
  const task = {
    artifact: { content: { note: 'genuine artifact text' } },
    dependencies: [],
    lockedAnswers: {
      id: 'answers@1',
      valid: true,
      approvedBy: { message: 'ok', at: '2026-10-11T00:00:00Z' },
      content: { inputs: { answers: { scene1Childhood: { memory: 'real memory text here' } } } }
    },
    inputs: { answers: { scene1Childhood: { memory: 'real memory text here' } } },
    creativeDirections: [{ direction: 'real direction text here' }],
    shotIntentions: {
      id: 'shots@1',
      valid: true,
      approvedBy: { message: 'ok', at: '2026-10-11T00:00:00Z' },
      content: { shots: [{ staging: 'real staging text here' }] }
    },
    productionBible: { status: 'signed', version: 1, sections: { cast: 'real cast text here' } }
  };
  assert.throws(
    () => verifyReviewQuotes({ role: 'text-reviewer', task, review: review('Completely fabricated sentence not found in any source'), outputs: new Map() }),
    /REVIEW_QUOTE_NOT_FOUND/
  );
});
