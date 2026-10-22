#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Main-thread only. Keeps this app and its WebKit tasks running while opted in.
/// The native preference is device-local and is never copied between accounts.
@interface FGBackgroundRuntime : NSObject
- (instancetype)initWithWebView:(WKWebView *)webView;
- (void)setEnabled:(BOOL)enabled;
- (void)report;
@end

NS_ASSUME_NONNULL_END
