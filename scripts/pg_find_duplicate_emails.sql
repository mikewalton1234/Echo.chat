-- Find case-insensitive duplicate emails (breaks the users_email_unique_ci index)
\set ON_ERROR_STOP on

SELECT lower(email) AS email_ci,
       COUNT(*)      AS n
  FROM users
 WHERE email IS NOT NULL AND btrim(email) <> ''
 GROUP BY lower(email)
HAVING COUNT(*) > 1
 ORDER BY n DESC, email_ci;
