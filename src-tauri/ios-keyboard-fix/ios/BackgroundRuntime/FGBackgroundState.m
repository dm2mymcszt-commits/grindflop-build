#import "FGBackgroundState.h"

NSDictionary<NSString *, id> *FGBackgroundState(BOOL supported, BOOL enabled,
    NSString *failure, NSString *detail, NSString *systemVersion) {
    return @{
        @"supported": supported ? @YES : @NO,
        @"enabled": enabled ? @YES : @NO,
        @"failure": failure,
        @"detail": detail,
        @"systemVersion": systemVersion,
    };
}
