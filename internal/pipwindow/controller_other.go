//go:build !windows

package pipwindow

type unsupportedController struct{}

func NewController() Controller {
	return unsupportedController{}
}

func (unsupportedController) Supported() bool {
	return false
}

func (unsupportedController) Apply(Config) error {
	return ErrNotSupported
}

func (unsupportedController) Stop() error {
	return ErrNotSupported
}
