import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReviewQuotes, matchQuote } from '../runtime/crew.mjs';

const taskFixture = {
  artifact: {
    content: {
      text: 'The Quick Brown Fox jumps smoothly over the Lazy Dog near the river bank.'
    }
  },
  dependencies: [],
  criteria: ['writing-fidelity']
};

const makeReview = quote => ({
  decision: 'approved',
  checks: [
    {
      criterion: 'writing-fidelity',
      status: 'pass',
      evidence: 'evidence text',
      location: 'whole',
      quotes: [quote]
    }
  ]
});

test('case-only difference passes', { timeout: 10000 }, () => {
  assert.doesNotThrow(() => {
    verifyReviewQuotes({
      role: 'text-reviewer',
      task: taskFixture,
      review: makeReview('the quick brown fox'),
      outputs: new Map()
    });
  });

  assert.doesNotThrow(() => {
    verifyReviewQuotes({
      role: 'text-reviewer',
      task: taskFixture,
      review: makeReview('THE QUICK BROWN FOX'),
      outputs: new Map()
    });
  });
});

test('ellipsis-joined fragments pass with ascii (...) and unicode (…)', { timeout: 10000 }, () => {
  // ASCII ellipsis
  assert.doesNotThrow(() => {
    verifyReviewQuotes({
      role: 'text-reviewer',
      task: taskFixture,
      review: makeReview('The Quick Brown ... Lazy Dog'),
      outputs: new Map()
    });
  });

  // Unicode ellipsis
  assert.doesNotThrow(() => {
    verifyReviewQuotes({
      role: 'text-reviewer',
      task: taskFixture,
      review: makeReview('quick brown … river bank'),
      outputs: new Map()
    });
  });

  // Empty fragments ignored, total length >= 8
  assert.doesNotThrow(() => {
    verifyReviewQuotes({
      role: 'text-reviewer',
      task: taskFixture,
      review: makeReview('Quick Brown ... ... river bank'),
      outputs: new Map()
    });
  });
});

test('out-of-order fragments fail', { timeout: 10000 }, () => {
  assert.throws(
    () => {
      verifyReviewQuotes({
        role: 'text-reviewer',
        task: taskFixture,
        review: makeReview('river bank ... Quick Brown'),
        outputs: new Map()
      });
    },
    /REVIEW_QUOTE_NOT_FOUND/
  );

  assert.throws(
    () => {
      verifyReviewQuotes({
        role: 'text-reviewer',
        task: taskFixture,
        review: makeReview('Lazy Dog … Quick Brown'),
        outputs: new Map()
      });
    },
    /REVIEW_QUOTE_NOT_FOUND/
  );
});

test('invented quote still fails with REVIEW_QUOTE_NOT_FOUND and length < 8 fails', { timeout: 10000 }, () => {
  // Invented quote
  assert.throws(
    () => {
      verifyReviewQuotes({
        role: 'text-reviewer',
        task: taskFixture,
        review: makeReview('an invented quote that is not present anywhere in the source'),
        outputs: new Map()
      });
    },
    /REVIEW_QUOTE_NOT_FOUND/
  );

  // Total fragment length < 8 fails even if individual fragments exist
  assert.throws(
    () => {
      verifyReviewQuotes({
        role: 'text-reviewer',
        task: taskFixture,
        review: makeReview('Fox ... Dog'), // 3 + 3 = 6 < 8
        outputs: new Map()
      });
    },
    /REVIEW_QUOTE_NOT_FOUND/
  );
});
