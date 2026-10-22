// GrindFlop: the sender's photo on a chat notification.

import Foundation
import Intents
import UserNotifications

/// A chat notification names its sender in `extra` (fgSenderId, fgSenderName,
/// fgConversationId, fgAvatarUrl). With those it is shown as a message from
/// that person, their photo round on the left as Messages does. That takes
/// the communication notifications entitlement, which the TrollStore build
/// signs in; should iOS refuse it anyway, the photo goes on as a thumbnail on
/// the right instead. Without a photo the notification is left as it was.
struct NotificationSender {
  let id: String
  let name: String
  let conversationId: String
  let photoUrl: URL

  init?(_ notification: Notification) {
    guard let extra = notification.extra,
      let id = extra["fgSenderId"], !id.isEmpty,
      let link = extra["fgAvatarUrl"], let url = URL(string: link), url.scheme == "https"
    else { return nil }
    self.id = id
    self.name = extra["fgSenderName"] ?? notification.title
    self.conversationId = extra["fgConversationId"] ?? notification.group ?? id
    self.photoUrl = url
  }
}

enum SenderPhoto {
  /// A run of messages from one person downloads their photo once.
  private static let cache: NSCache<NSURL, NSData> = {
    let cache = NSCache<NSURL, NSData>()
    cache.countLimit = 50
    return cache
  }()

  /// Hands back the content with the sender's photo on it, or as it was when
  /// the photo cannot be had. Waits on the download, a few seconds at most.
  static func decorate(
    _ content: UNNotificationContent, from sender: NotificationSender,
    completion: @escaping (UNNotificationContent) -> Void
  ) {
    load(sender.photoUrl) { data in
      guard let data = data else {
        completion(content)
        return
      }
      if let updated = asMessage(content, from: sender, photo: data) {
        completion(updated)
      } else {
        completion(withThumbnail(content, photo: data))
      }
    }
  }

  private static func load(_ url: URL, completion: @escaping (Data?) -> Void) {
    if let cached = cache.object(forKey: url as NSURL) {
      completion(cached as Data)
      return
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 5
    URLSession.shared.dataTask(with: request) { data, response, error in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard error == nil, status == 200, let data = data, !data.isEmpty else {
        NSLog("[GrindFlop] sender photo download failed: %d %@", status, error?.localizedDescription ?? "")
        completion(nil)
        return
      }
      cache.setObject(data as NSData, forKey: url as NSURL)
      completion(data)
    }.resume()
  }

  /// The communication notification: an incoming message intent, donated,
  /// that the content is then updated from.
  private static func asMessage(
    _ content: UNNotificationContent, from sender: NotificationSender, photo: Data
  ) -> UNNotificationContent? {
    guard #available(iOS 15.0, *) else { return nil }
    let person = INPerson(
      personHandle: INPersonHandle(value: sender.id, type: .unknown),
      nameComponents: nil,
      displayName: sender.name,
      image: INImage(imageData: photo),
      contactIdentifier: nil,
      customIdentifier: sender.id)
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: content.body,
      speakableGroupName: nil,
      conversationIdentifier: sender.conversationId,
      serviceName: nil,
      sender: person,
      attachments: nil)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { error in
      if let error = error {
        NSLog("[GrindFlop] message intent donation failed: %@", error.localizedDescription)
      }
    }
    do {
      return try content.updating(from: intent)
    } catch {
      NSLog("[GrindFlop] communication notification refused: %@", error.localizedDescription)
      return nil
    }
  }

  private static func withThumbnail(_ content: UNNotificationContent, photo: Data)
    -> UNNotificationContent
  {
    guard let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return content }
    // The attachment takes the file over, so each one gets its own.
    let file = FileManager.default.temporaryDirectory
      .appendingPathComponent("fg-sender-\(UUID().uuidString).jpg")
    do {
      try photo.write(to: file)
      let attachment = try UNNotificationAttachment(
        identifier: "sender-photo", url: file,
        options: [UNNotificationAttachmentOptionsTypeHintKey: "public.jpeg"])
      mutable.attachments = [attachment]
    } catch {
      NSLog("[GrindFlop] sender photo attachment failed: %@", error.localizedDescription)
      try? FileManager.default.removeItem(at: file)
      return content
    }
    return mutable
  }
}
