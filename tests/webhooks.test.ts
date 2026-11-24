// Tests for the DOCUMENTED InstantDM inbound webhook envelopes
// (instantdm.com/instagram-api-docs). Written in expanded form on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPayload } from '../src/platform/instantdm.js';

test('dm_received: documented raw Meta envelope maps to a dm event', () => {
  const raw = {
    object: 'instagram',
    entry: [{
      time: 1778223729706,
      id: '17841476961942794',
      messaging: [{
        sender: { id: '978239761327698' },
        recipient: { id: '17841476961942794' },
        timestamp: 1778223722476,
        message: { mid: 'aWdfZAG1faXRlbToxOklHTWVz', text: 'New' },
      }],
    }],
  };
  const ev = mapPayload(raw)[0]!;
  assert.equal(ev.type, 'dm');
  if (ev.type === 'dm') {
    assert.equal(ev.platformUserId, '978239761327698');
    assert.equal(ev.text, 'New');
    assert.equal(ev.messageId, 'aWdfZAG1faXRlbToxOklHTWVz');
    assert.equal(ev.at.getTime(), 1778223722476);
    assert.equal(ev.isStoryReply, false);
  }
});

test('dm_received attachments (voice note) and story replies inside the envelope', () => {
  const voiceRaw = {
    object: 'instagram',
    entry: [{
      time: 1,
      id: 'a',
      messaging: [{
        sender: { id: 's1' },
        recipient: { id: 'r1' },
        timestamp: 2,
        message: { mid: 'm-voice', attachments: [{ type: 'audio', payload: { url: 'https://x/a.mp3' } }] },
      }],
    }],
  };
  const voice = mapPayload(voiceRaw)[0]!;
  assert.equal(voice.type, 'dm');
  if (voice.type === 'dm') assert.equal(voice.attachments?.[0]?.kind, 'audio');

  const storyRaw = {
    object: 'instagram',
    entry: [{
      id: 'a',
      time: 1,
      messaging: [{
        sender: { id: 's1' },
        recipient: { id: 'r1' },
        timestamp: 2,
        message: { mid: 'm-story', text: 'love this', attachments: [{ type: 'story_mention', payload: { url: 'https://x/s.jpg' } }] },
      }],
    }],
  };
  const story = mapPayload(storyRaw)[0]!;
  assert.equal(story.type, 'dm');
  if (story.type === 'dm') assert.equal(story.isStoryReply, true);
});

test('comment: documented envelope maps author, username, media', () => {
  const raw = {
    object: 'instagram',
    entry: [{
      id: '17841435672868203',
      time: 1778223729,
      changes: [{
        field: 'comments',
        value: {
          from: { id: '27021621630806157', username: 'pvamsi.krishna.73' },
          media: { id: '17933258556187263', media_product_type: 'REELS' },
          id: '18114716611826474',
          text: '2013',
          recipient_id: '17841435672868203',
          sender_id: '27021621630806157',
        },
      }],
    }],
  };
  const ev = mapPayload(raw)[0]!;
  assert.equal(ev.type, 'comment');
  if (ev.type === 'comment') {
    assert.equal(ev.commentId, '18114716611826474');
    assert.equal(ev.authorId, '27021621630806157');
    assert.equal(ev.username, 'pvamsi.krishna.73');
    assert.equal(ev.postId, '17933258556187263');
    assert.equal(ev.text, '2013');
    assert.equal(ev.at.getTime(), 1778223729000);
  }
});

test('postback: title plus JSON-string payload parsed for username', () => {
  const raw = {
    object: 'instagram',
    entry: [{
      id: '17841408795204378',
      time: 1778223725146,
      messaging: [{
        sender: { id: '2031528510825908' },
        recipient: { id: '17841408795204378' },
        timestamp: 1778223723887,
        postback: {
          title: 'Started following you!',
          payload: JSON.stringify({
            from: { id: '2031528510825908', username: '__zain_z' },
            media: { id: '17939513463036158' },
            text: 'prompt',
          }),
          mid: 'aWdfZAG1faXRlbToxOklHTWVz',
        },
      }],
    }],
  };
  const ev = mapPayload(raw)[0]!;
  assert.equal(ev.type, 'postback');
  if (ev.type === 'postback') {
    assert.equal(ev.platformUserId, '2031528510825908');
    assert.equal(ev.username, '__zain_z');
    assert.equal(ev.title, 'Started following you!');
  }
});

test('question_answered and flow_completed: documented flat payloads with string timestamps', () => {
  const qaRaw = {
    flow_id: 'f1',
    sender_id: '2031528510825908',
    sender_username: '__zain_z',
    question: "What's your name?",
    question_type: 'text',
    custom_variable_name: 'user_name',
    user_response: 'Zain',
    skip: false,
    attempt_no: '1',
    timestamp: '2026-05-06 04:45:30.123456',
  };
  const qa = mapPayload(qaRaw)[0]!;
  assert.equal(qa.type, 'question_answered');
  if (qa.type === 'question_answered') {
    assert.equal(qa.answer, 'Zain');
    assert.equal(qa.username, '__zain_z');
  }

  const skipped = mapPayload({ sender_id: 's', question: 'Q?', user_response: '', skip: true })[0]!;
  assert.equal(skipped.type, 'ignored');

  const fcRaw = {
    flow_id: 'f1',
    flow_name: 'Lead Capture Flow',
    sender_id: '2031528510825908',
    sender_username: '__zain_z',
    completed_at: '2026-05-06 04:46:15.654321',
    attempt_no: '1',
    tags: [],
    response_variables: { user_name: 'Zain' },
    question_responses: [],
  };
  const fc = mapPayload(fcRaw)[0]!;
  assert.equal(fc.type, 'flow_completed');
  if (fc.type === 'flow_completed') assert.equal(fc.flowName, 'Lead Capture Flow');
});
