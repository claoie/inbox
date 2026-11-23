-- One-off: unwrap Sent-copy Message-IDs stored as <<token@mail-domain>@user-domain>
-- back to the <token@mail-domain> the recipients actually received.
--
-- Run once, after the send-path fix is deployed. Idempotent: every statement
-- only matches the double-wrapped shape, which the fixed send path no longer
-- writes.
--
-- Three columns carry the malformed id: message_id on the Sent copy itself,
-- and in_reply_to / reference_ids on replies composed from the Sent box. All
-- three are unwrapped so those replies still thread under the Sent copy.
--
-- A Sent row whose unwrapped id already exists for the same user is left as is
-- rather than failing the (user_id, message_id) unique index; the final SELECT
-- reports how many remain.

BEGIN;

UPDATE mails AS m
SET message_id = regexp_replace(m.message_id, '^<(<[^<>]+>)@[^<>]+>$', '\1'),
    updated = NOW()
WHERE m.message_id ~ '^<<[^<>]+>@[^<>]+>$'
  AND NOT EXISTS (
    SELECT 1 FROM mails AS other
    WHERE other.user_id = m.user_id
      AND other.message_id = regexp_replace(m.message_id, '^<(<[^<>]+>)@[^<>]+>$', '\1')
  );

UPDATE mails
SET in_reply_to = regexp_replace(in_reply_to, '^<(<[^<>]+>)@[^<>]+>$', '\1'),
    updated = NOW()
WHERE in_reply_to ~ '^<<[^<>]+>@[^<>]+>$';

UPDATE mails AS m
SET reference_ids = (
      SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(ref) = 'string'
                   THEN to_jsonb(regexp_replace(ref #>> '{}', '^<(<[^<>]+>)@[^<>]+>$', '\1'))
                 ELSE ref
               END
               ORDER BY position
             )
      FROM jsonb_array_elements(m.reference_ids) WITH ORDINALITY AS refs(ref, position)
    ),
    updated = NOW()
WHERE jsonb_typeof(m.reference_ids) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(m.reference_ids) AS refs(ref)
    WHERE ref ~ '^<<[^<>]+>@[^<>]+>$'
  );

SELECT
  count(*) FILTER (WHERE message_id ~ '^<<[^<>]+>@[^<>]+>$') AS message_id_still_wrapped,
  count(*) FILTER (WHERE in_reply_to ~ '^<<[^<>]+>@[^<>]+>$') AS in_reply_to_still_wrapped
FROM mails;

COMMIT;
