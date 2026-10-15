// Importer ce fichier enregistre tous les modèles auprès de Sequelize
import { AuditLog } from "./audit-log.model.js";
import { Category, Product, Supplier, Unit } from "./catalog.models.js";
import { Company } from "./company.model.js";
import { EmailOtpCode } from "./email-otp-code.model.js";
import { Membership, MembershipShop } from "./membership.model.js";
import { PasswordToken } from "./password-token.model.js";
import {
  CashSession,
  Customer,
  CustomerLedgerEntry,
  PaymentMethod,
  Sale,
  SaleLine,
  SalePayment,
  SaleReturn,
  SaleReturnLine,
} from "./pos.models.js";
import {
  GoodsReceipt,
  GoodsReceiptLine,
  IdempotencyKey,
  PurchaseOrder,
  PurchaseOrderLine,
  SupplierInvoice,
  SupplierPayment,
  SupplierReturn,
  SupplierReturnLine,
} from "./purchases.models.js";
import { RefreshToken } from "./refresh-token.model.js";
import { Role, RolePermission } from "./role.model.js";
import { Shop } from "./shop.model.js";
import {
  InventoryCount,
  InventoryCountLine,
  StockAdjustment,
  StockLevel,
  StockMovement,
  StockTransfer,
  StockTransferLine,
} from "./stock.models.js";
import { User } from "./user.model.js";

// --- Authentification : supprimer un utilisateur supprime ses sessions, codes OTP et liens
User.hasMany(RefreshToken, { foreignKey: "userId", onDelete: "CASCADE" });
RefreshToken.belongsTo(User, { foreignKey: "userId" });

User.hasMany(EmailOtpCode, { foreignKey: "userId", onDelete: "CASCADE" });
EmailOtpCode.belongsTo(User, { foreignKey: "userId" });

User.hasMany(PasswordToken, { foreignKey: "userId", onDelete: "CASCADE" });
PasswordToken.belongsTo(User, { foreignKey: "userId" });

// --- Entreprises (les suppressions sont bloquées en base : on archive ou on suspend)
Company.hasMany(Shop, { foreignKey: "companyId", as: "shops" });
Shop.belongsTo(Company, { foreignKey: "companyId", as: "company" });

Company.hasMany(Role, { foreignKey: "companyId", as: "roles" });
Role.belongsTo(Company, { foreignKey: "companyId", as: "company" });
Role.hasMany(RolePermission, { foreignKey: "roleId", as: "permissions" });

Company.hasMany(Membership, { foreignKey: "companyId", as: "memberships" });
Membership.belongsTo(Company, { foreignKey: "companyId", as: "company" });
User.hasMany(Membership, { foreignKey: "userId", as: "memberships" });
Membership.belongsTo(User, { foreignKey: "userId", as: "user" });
Membership.belongsTo(Role, { foreignKey: "roleId", as: "role" });
Membership.belongsToMany(Shop, {
  through: MembershipShop,
  foreignKey: "membershipId",
  otherKey: "shopId",
  as: "shops",
});

// --- Catalogue
Product.belongsTo(Category, { foreignKey: "categoryId", as: "category" });
Product.belongsTo(Unit, { foreignKey: "unitId", as: "unit" });
Category.belongsTo(Category, { foreignKey: "parentId", as: "parent" });

// --- Stock
StockLevel.belongsTo(Product, { foreignKey: "productId", as: "product" });
StockLevel.belongsTo(Shop, { foreignKey: "shopId", as: "shop" });
StockMovement.belongsTo(Product, { foreignKey: "productId", as: "product" });
StockTransfer.hasMany(StockTransferLine, { foreignKey: "transferId", as: "lines" });
StockTransferLine.belongsTo(Product, { foreignKey: "productId", as: "product" });
InventoryCount.hasMany(InventoryCountLine, { foreignKey: "inventoryId", as: "lines" });
InventoryCountLine.belongsTo(Product, { foreignKey: "productId", as: "product" });

// --- Achats
PurchaseOrder.hasMany(PurchaseOrderLine, { foreignKey: "orderId", as: "lines" });
PurchaseOrder.belongsTo(Supplier, { foreignKey: "supplierId", as: "supplier" });
PurchaseOrderLine.belongsTo(Product, { foreignKey: "productId", as: "product" });
GoodsReceipt.hasMany(GoodsReceiptLine, { foreignKey: "receiptId", as: "lines" });
GoodsReceiptLine.belongsTo(Product, { foreignKey: "productId", as: "product" });
SupplierReturn.hasMany(SupplierReturnLine, { foreignKey: "returnId", as: "lines" });
SupplierReturnLine.belongsTo(Product, { foreignKey: "productId", as: "product" });
SupplierInvoice.hasMany(SupplierPayment, { foreignKey: "invoiceId", as: "payments" });
SupplierInvoice.belongsTo(Supplier, { foreignKey: "supplierId", as: "supplier" });

// --- Caisse
Sale.hasMany(SaleLine, { foreignKey: "saleId", as: "lines" });
Sale.hasMany(SalePayment, { foreignKey: "saleId", as: "payments" });
Sale.belongsTo(Customer, { foreignKey: "customerId", as: "customer" });
SaleLine.belongsTo(Product, { foreignKey: "productId", as: "product" });
SalePayment.belongsTo(PaymentMethod, { foreignKey: "paymentMethodId", as: "paymentMethod" });
SaleReturn.hasMany(SaleReturnLine, { foreignKey: "returnId", as: "lines" });

export {
  AuditLog,
  CashSession,
  Category,
  Company,
  Customer,
  CustomerLedgerEntry,
  EmailOtpCode,
  GoodsReceipt,
  GoodsReceiptLine,
  IdempotencyKey,
  InventoryCount,
  InventoryCountLine,
  Membership,
  MembershipShop,
  PasswordToken,
  PaymentMethod,
  Product,
  PurchaseOrder,
  PurchaseOrderLine,
  RefreshToken,
  Role,
  RolePermission,
  Sale,
  SaleLine,
  SalePayment,
  SaleReturn,
  SaleReturnLine,
  Shop,
  StockAdjustment,
  StockLevel,
  StockMovement,
  StockTransfer,
  StockTransferLine,
  Supplier,
  SupplierInvoice,
  SupplierPayment,
  SupplierReturn,
  SupplierReturnLine,
  Unit,
  User,
};
