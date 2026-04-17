import 'package:json_annotation/json_annotation.dart';

part 'models.g.dart';

// User model
@JsonSerializable()
class User {
  final int id;
  final String uid;
  final String email;
  final int companyId;
  final String companyName;
  final String role;
  final String? fullName;
  final String? phone;

  User({
    required this.id,
    required this.uid,
    required this.email,
    required this.companyId,
    required this.companyName,
    required this.role,
    this.fullName,
    this.phone,
  });

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
  Map<String, dynamic> toJson() => _$UserToJson(this);
}

// Product model
@JsonSerializable()
class Product {
  final int id;
  final String uniqueId;
  final int companyId;
  final String name;
  final String slug;
  final int? categoryId;
  final String? category;
  final String? categoryImageUrl;
  final String description;
  final String unitLabel;
  final int priceCents;
  final int? originalPriceCents;
  final int stockQuantity;
  final String? badge;
  final String? imageUrl;
  final bool isActive;
  final bool isOnOffer;
  final int? offerPriceCents;
  final String offerType;
  final String createdDate;
  final String updatedDate;

  Product({
    required this.id,
    required this.uniqueId,
    required this.companyId,
    required this.name,
    required this.slug,
    this.categoryId,
    this.category,
    this.categoryImageUrl,
    required this.description,
    required this.unitLabel,
    required this.priceCents,
    this.originalPriceCents,
    required this.stockQuantity,
    this.badge,
    this.imageUrl,
    required this.isActive,
    required this.isOnOffer,
    this.offerPriceCents,
    required this.offerType,
    required this.createdDate,
    required this.updatedDate,
  });

  factory Product.fromJson(Map<String, dynamic> json) => _$ProductFromJson(json);
  Map<String, dynamic> toJson() => _$ProductToJson(this);

  double get effectivePrice => (isOnOffer && offerPriceCents != null ? offerPriceCents! : priceCents) / 100.0;
}

// Category model
@JsonSerializable()
class Category {
  final int id;
  final int companyId;
  final String name;
  final String slug;
  final String? imageUrl;
  final String createdDate;
  final String updatedDate;

  Category({
    required this.id,
    required this.companyId,
    required this.name,
    required this.slug,
    this.imageUrl,
    required this.createdDate,
    required this.updatedDate,
  });

  factory Category.fromJson(Map<String, dynamic> json) => _$CategoryFromJson(json);
  Map<String, dynamic> toJson() => _$CategoryToJson(this);
}

// Order Item model
@JsonSerializable()
class OrderItem {
  final int id;
  final int? productId;
  final String productName;
  final String unitLabel;
  final int quantity;
  final int unitPriceCents;
  final int lineTotalCents;

  OrderItem({
    required this.id,
    this.productId,
    required this.productName,
    required this.unitLabel,
    required this.quantity,
    required this.unitPriceCents,
    required this.lineTotalCents,
  });

  factory OrderItem.fromJson(Map<String, dynamic> json) => _$OrderItemFromJson(json);
  Map<String, dynamic> toJson() => _$OrderItemToJson(this);
}

// Order model
@JsonSerializable()
class Order {
  final int id;
  final String publicId;
  final int companyId;
  final String customerName;
  final String customerPhone;
  final String? customerEmail;
  final String deliveryAddress;
  final String? deliveryNotes;
  final String? deliverySlot;
  final int subtotalCents;
  final int taxCents;
  final int deliveryFeeCents;
  final int totalCents;
  final String status;
  final String paymentMethod;
  final bool isPaid;
  final String createdDate;
  final String updatedDate;
  final int? assignedRiderUserId;
  final String? riderName;
  final String? riderPhone;
  final List<OrderItem> items;

  Order({
    required this.id,
    required this.publicId,
    required this.companyId,
    required this.customerName,
    required this.customerPhone,
    this.customerEmail,
    required this.deliveryAddress,
    this.deliveryNotes,
    this.deliverySlot,
    required this.subtotalCents,
    required this.taxCents,
    required this.deliveryFeeCents,
    required this.totalCents,
    required this.status,
    required this.paymentMethod,
    required this.isPaid,
    required this.createdDate,
    required this.updatedDate,
    this.assignedRiderUserId,
    this.riderName,
    this.riderPhone,
    required this.items,
  });

  factory Order.fromJson(Map<String, dynamic> json) => _$OrderFromJson(json);
  Map<String, dynamic> toJson() => _$OrderToJson(this);

  double get total => totalCents / 100.0;
}

// Company Info model
@JsonSerializable()
class CompanyInfo {
  final int id;
  final String name;
  final String slug;
  final String description;
  final String supportPhone;
  final String supportEmail;
  final List<String> promises;
  final double? storeLatitude;
  final double? storeLongitude;

  CompanyInfo({
    required this.id,
    required this.name,
    required this.slug,
    required this.description,
    required this.supportPhone,
    required this.supportEmail,
    required this.promises,
    this.storeLatitude,
    this.storeLongitude,
  });

  factory CompanyInfo.fromJson(Map<String, dynamic> json) => _$CompanyInfoFromJson(json);
  Map<String, dynamic> toJson() => _$CompanyInfoToJson(this);
}

// Saved Address model
@JsonSerializable()
class SavedAddress {
  final int id;
  final String fullName;
  final String phone;
  final String deliveryAddress;
  final String? deliveryNotes;
  final double? latitude;
  final double? longitude;
  final int useCount;
  final String lastUsedDate;

  SavedAddress({
    required this.id,
    required this.fullName,
    required this.phone,
    required this.deliveryAddress,
    this.deliveryNotes,
    this.latitude,
    this.longitude,
    required this.useCount,
    required this.lastUsedDate,
  });

  factory SavedAddress.fromJson(Map<String, dynamic> json) => _$SavedAddressFromJson(json);
  Map<String, dynamic> toJson() => _$SavedAddressToJson(this);
}

// Rider Location model
@JsonSerializable()
class RiderLocation {
  final int riderId;
  final double latitude;
  final double longitude;
  final String capturedAt;

  RiderLocation({
    required this.riderId,
    required this.latitude,
    required this.longitude,
    required this.capturedAt,
  });

  factory RiderLocation.fromJson(Map<String, dynamic> json) => _$RiderLocationFromJson(json);
  Map<String, dynamic> toJson() => _$RiderLocationToJson(this);
}

// Dashboard Summary model
@JsonSerializable()
class DashboardSummary {
  final int totalOrders;
  final int totalOrdersCents;
  final int todayOrdersCents;
  final Map<String, int> ordersByStatus;

  DashboardSummary({
    required this.totalOrders,
    required this.totalOrdersCents,
    required this.todayOrdersCents,
    required this.ordersByStatus,
  });

  factory DashboardSummary.fromJson(Map<String, dynamic> json) => _$DashboardSummaryFromJson(json);
  Map<String, dynamic> toJson() => _$DashboardSummaryToJson(this);
}

// Rider model
@JsonSerializable()
class Rider {
  final int id;
  final String email;
  final String fullName;
  final String phone;

  Rider({
    required this.id,
    required this.email,
    required this.fullName,
    required this.phone,
  });

  factory Rider.fromJson(Map<String, dynamic> json) => _$RiderFromJson(json);
  Map<String, dynamic> toJson() => _$RiderToJson(this);
}

// Team Member model
@JsonSerializable()
class TeamMember {
  final int id;
  final String email;
  final String role;
  final String fullName;
  final String? phone;

  TeamMember({
    required this.id,
    required this.email,
    required this.role,
    required this.fullName,
    this.phone,
  });

  factory TeamMember.fromJson(Map<String, dynamic> json) => _$TeamMemberFromJson(json);
  Map<String, dynamic> toJson() => _$TeamMemberToJson(this);
}

// Auth Response model
@JsonSerializable()
class AuthResponse {
  final String token;
  final User user;

  AuthResponse({
    required this.token,
    required this.user,
  });

  factory AuthResponse.fromJson(Map<String, dynamic> json) => _$AuthResponseFromJson(json);
  Map<String, dynamic> toJson() => _$AuthResponseToJson(this);
}
