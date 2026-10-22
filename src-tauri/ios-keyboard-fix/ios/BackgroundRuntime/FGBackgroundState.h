#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Shared with the Foundation-only wire-format test on macOS. Keep booleans
// explicit: boxing an Objective-C comparison can produce JSON 0/1 instead.
NSDictionary<NSString *, id> *FGBackgroundState(BOOL supported, BOOL enabled,
    NSString *failure, NSString *detail, NSString *systemVersion);

NS_ASSUME_NONNULL_END
