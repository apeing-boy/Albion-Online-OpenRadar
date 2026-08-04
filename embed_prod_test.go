//go:build !dev

package assets

import (
	"io/fs"
	"strings"
	"testing"
)

func TestProdEmbedExcludesTestsAndFixtures(t *testing.T) {
	err := fs.WalkDir(Scripts, "web/scripts", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.Contains(path, "__fixtures__") {
			t.Errorf("unexpected fixture in prod embed: %s", path)
		}
		if strings.HasSuffix(path, ".test.js") {
			t.Errorf("unexpected test file in prod embed: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestProdEmbedExcludesExternalMaps(t *testing.T) {
	if _, err := fs.Stat(Images, "web/images/Maps"); err == nil {
		t.Fatal("web/images/Maps must not be embedded in production binaries")
	}
	if _, err := fs.Stat(Images, "web/images/icon.png"); err != nil {
		t.Fatalf("non-map image assets must remain embedded: %v", err)
	}
}
