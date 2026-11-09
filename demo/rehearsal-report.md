# helpii removal rehearsal

Commit: 871e558de80d2146f6403502bc44e17660b4be4f

Target and command:

```
unused.mjs
["node","check.mjs"]
```

## Result

Selected check passed before and after removal.

- Baseline: PASS (0, 0.05s)

- Removal: PASS (0, 0.04s)

## Proposed diff

```
diff --git a/unused.mjs b/unused.mjs
deleted file mode 100644
index 7d28864..0000000
--- a/unused.mjs
+++ /dev/null
@@ -1 +0,0 @@
-export const unused = 1;

```

## Baseline output

```

```

## Removal output

```

```

## Coverage limits

Integrity checks inspect the worktrees after the command exits. Temporary changes undone within the command may go undetected. Only the selected command was run. External callers, deployment-only jobs, and untested behavior remain unverified. Review this report for sensitive data before sharing.

