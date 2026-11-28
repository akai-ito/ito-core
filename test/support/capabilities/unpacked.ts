// A capability whose package the server never installed, as when a deploy skipped `npm ci`: it stops as it starts.
// @ts-expect-error -- the package is missing on purpose.
import "ito-test-missing-package";
