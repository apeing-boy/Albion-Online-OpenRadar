//go:build windows

package pipwindow

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wsExLayered = 0x00080000
	wsExTopmost = 0x00000008
	lwaAlpha    = 0x00000002

	monitorDefaultToNearest = 0x00000002

	swpNoSize     = 0x0001
	swpNoActivate = 0x0010
	swpShowWindow = 0x0040
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")

	procEnumWindows                = user32.NewProc("EnumWindows")
	procGetClassNameW              = user32.NewProc("GetClassNameW")
	procGetWindowLongPtrW          = user32.NewProc("GetWindowLongPtrW")
	procGetWindowRect              = user32.NewProc("GetWindowRect")
	procGetWindowTextLengthW       = user32.NewProc("GetWindowTextLengthW")
	procGetWindowTextW             = user32.NewProc("GetWindowTextW")
	procIsWindowVisible            = user32.NewProc("IsWindowVisible")
	procMonitorFromWindow          = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW            = user32.NewProc("GetMonitorInfoW")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	procSetWindowLongPtrW          = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos               = user32.NewProc("SetWindowPos")
)

var (
	gwlExStyle  = ^uintptr(19) // -20 as an unsigned pointer-sized value.
	hwndTopmost = ^uintptr(0)  // HWND_TOPMOST (-1).
)

type rect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

type candidate struct {
	handle uintptr
	rect   rect
	score  int
}

type windowsController struct{}

func NewController() Controller {
	return windowsController{}
}

func (windowsController) Supported() bool {
	return true
}

func (windowsController) Apply(config Config) error {
	if err := config.Validate(); err != nil {
		return err
	}

	window, err := findPictureInPictureWindow()
	if err != nil {
		return err
	}

	exStyle, _, _ := procGetWindowLongPtrW.Call(window.handle, gwlExStyle)
	if exStyle&wsExLayered == 0 {
		result, _, callErr := procSetWindowLongPtrW.Call(window.handle, gwlExStyle, exStyle|wsExLayered)
		if result == 0 && callErr != windows.ERROR_SUCCESS {
			return fmt.Errorf("enable window transparency: %w", callErr)
		}
	}

	alpha := byte((config.Opacity*255 + 50) / 100)
	result, _, callErr := procSetLayeredWindowAttributes.Call(window.handle, 0, uintptr(alpha), lwaAlpha)
	if result == 0 {
		return fmt.Errorf("set window opacity: %w", callErr)
	}

	if config.Position == PositionCurrent {
		return nil
	}

	x, y, err := positionFor(window, config.Position, config.Margin)
	if err != nil {
		return err
	}

	result, _, callErr = procSetWindowPos.Call(
		window.handle,
		hwndTopmost,
		uintptr(x),
		uintptr(y),
		0,
		0,
		swpNoSize|swpNoActivate|swpShowWindow,
	)
	if result == 0 {
		return fmt.Errorf("move Picture-in-Picture window: %w", callErr)
	}

	return nil
}

func findPictureInPictureWindow() (candidate, error) {
	var best candidate
	callback := windows.NewCallback(func(handle uintptr, _ uintptr) uintptr {
		visible, _, _ := procIsWindowVisible.Call(handle)
		if visible == 0 {
			return 1
		}

		var bounds rect
		ok, _, _ := procGetWindowRect.Call(handle, uintptr(unsafe.Pointer(&bounds)))
		if ok == 0 {
			return 1
		}

		width := int(bounds.Right - bounds.Left)
		height := int(bounds.Bottom - bounds.Top)
		if width < 100 || height < 100 || width > 1800 || height > 1800 {
			return 1
		}

		className := strings.ToLower(windowClass(handle))
		title := strings.ToLower(windowTitle(handle))
		knownClass := strings.HasPrefix(className, "chrome_widgetwin_") ||
			strings.Contains(className, "mozilla")
		knownTitle := isPictureInPictureTitle(title)
		if !knownClass && !knownTitle {
			return 1
		}

		exStyle, _, _ := procGetWindowLongPtrW.Call(handle, gwlExStyle)
		topmost := exStyle&wsExTopmost != 0
		if !topmost && !knownTitle {
			return 1
		}

		// The radar stream is square. Requiring a near-square shape when the
		// browser does not expose a recognizable PiP title avoids touching an
		// unrelated always-on-top Chrome/Edge window.
		shapeDifference := abs(width - height)
		if !knownTitle && shapeDifference >= 300 {
			return 1
		}

		score := 0
		if strings.Contains(title, "openradar") {
			score += 2000
		}
		if knownTitle {
			score += 1000
		}
		if topmost {
			score += 400
		}
		if knownClass {
			score += 150
		}

		if shapeDifference < 250 {
			score += 250 - shapeDifference
		}

		area := width * height
		if score > best.score || (score == best.score && area < rectArea(best.rect)) {
			best = candidate{handle: handle, rect: bounds, score: score}
		}

		return 1
	})

	result, _, callErr := procEnumWindows.Call(callback, 0)
	if result == 0 {
		return candidate{}, fmt.Errorf("enumerate desktop windows: %w", callErr)
	}
	if best.handle == 0 {
		return candidate{}, ErrWindowNotFound
	}
	return best, nil
}

func windowClass(handle uintptr) string {
	buffer := make([]uint16, 256)
	length, _, _ := procGetClassNameW.Call(
		handle,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)
	if length == 0 {
		return ""
	}
	return windows.UTF16ToString(buffer[:length])
}

func windowTitle(handle uintptr) string {
	length, _, _ := procGetWindowTextLengthW.Call(handle)
	if length == 0 {
		return ""
	}

	buffer := make([]uint16, int(length)+1)
	copied, _, _ := procGetWindowTextW.Call(
		handle,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)
	if copied == 0 {
		return ""
	}
	return windows.UTF16ToString(buffer[:copied])
}

func isPictureInPictureTitle(title string) bool {
	for _, marker := range []string{
		"picture in picture",
		"picture-in-picture",
		"картинка в картинке",
		"bild-in-bild",
		"image dans l'image",
		"imagen en imagen",
	} {
		if strings.Contains(title, marker) {
			return true
		}
	}
	return false
}

func positionFor(window candidate, position string, margin int) (int32, int32, error) {
	monitor, _, _ := procMonitorFromWindow.Call(window.handle, monitorDefaultToNearest)
	if monitor == 0 {
		return 0, 0, errors.New("find monitor for Picture-in-Picture window")
	}

	info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	result, _, callErr := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&info)))
	if result == 0 {
		return 0, 0, fmt.Errorf("read monitor work area: %w", callErr)
	}

	width := window.rect.Right - window.rect.Left
	height := window.rect.Bottom - window.rect.Top
	gap := int32(margin)

	switch position {
	case PositionTopLeft:
		return info.Work.Left + gap, info.Work.Top + gap, nil
	case PositionTopRight:
		return info.Work.Right - width - gap, info.Work.Top + gap, nil
	case PositionBottomLeft:
		return info.Work.Left + gap, info.Work.Bottom - height - gap, nil
	case PositionBottomRight:
		return info.Work.Right - width - gap, info.Work.Bottom - height - gap, nil
	case PositionCenter:
		return info.Work.Left + (info.Work.Right-info.Work.Left-width)/2,
			info.Work.Top + (info.Work.Bottom-info.Work.Top-height)/2, nil
	default:
		return 0, 0, fmt.Errorf("unsupported position %q", position)
	}
}

func rectArea(bounds rect) int {
	if bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top {
		return int(^uint(0) >> 1)
	}
	return int(bounds.Right-bounds.Left) * int(bounds.Bottom-bounds.Top)
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
