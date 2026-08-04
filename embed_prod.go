//go:build !dev

package assets

import "embed"

// Embedded static assets for the web server (production build).
// Maps are deliberately excluded and shipped next to the binaries so they can
// be updated without rebuilding OpenRadar.

//go:embed all:web/images/Enemies all:web/images/Flags all:web/images/Items all:web/images/Resources all:web/images/Spells web/images/favicon.ico web/images/icon.png
var Images embed.FS

// Scripts omits `all:` so Go embed skips _*.test.js and __fixtures__/.
//
//go:embed web/scripts
var Scripts embed.FS

//go:embed all:web/ao-bin-dumps
var Data embed.FS

//go:embed all:web/sounds
var Sounds embed.FS

//go:embed all:web/styles
var Styles embed.FS

//go:embed all:internal/templates
var Templates embed.FS
