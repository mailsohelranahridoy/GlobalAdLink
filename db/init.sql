-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin','advertiser','publisher')),
    company_name VARCHAR(255),
    wallet_address VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Wallets
CREATE TABLE wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_usdt DECIMAL(20,8) DEFAULT 0 CHECK (balance_usdt >= 0),
    version INT DEFAULT 1
);

-- Ad campaigns
CREATE TABLE ad_campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    advertiser_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    creative_url TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    ad_type VARCHAR(20) NOT NULL,
    action_button_type VARCHAR(50),
    action_button_data JSONB,
    targeting JSONB,
    bid_type VARCHAR(3) CHECK (bid_type IN ('CPC','CPM')),
    bid_amount DECIMAL(10,6) NOT NULL,
    daily_budget DECIMAL(20,8),
    total_budget DECIMAL(20,8),
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Ad units (for publishers)
CREATE TABLE ad_units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    publisher_id UUID REFERENCES users(id) ON DELETE CASCADE,
    unit_name VARCHAR(255) NOT NULL,
    unit_type VARCHAR(20) CHECK (unit_type IN ('js_tag','json_api')),
    dimensions VARCHAR(50),
    js_tag_code TEXT,
    api_key UUID UNIQUE DEFAULT uuid_generate_v4(),
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Clicks log (immutable)
CREATE TABLE clicks_log (
    id BIGSERIAL PRIMARY KEY,
    ad_campaign_id UUID REFERENCES ad_campaigns(id),
    ad_unit_id UUID REFERENCES ad_units(id),
    publisher_id UUID REFERENCES users(id),
    device_id VARCHAR(255) NOT NULL,
    fingerprint_hash VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    country VARCHAR(2),
    city VARCHAR(100),
    isp VARCHAR(255),
    click_timestamp TIMESTAMP DEFAULT NOW(),
    time_to_click_ms INT,
    recaptcha_score FLOAT,
    is_bot BOOLEAN DEFAULT FALSE,
    fraud_reason TEXT,
    is_fraud BOOLEAN DEFAULT FALSE,
    revenue_usdt DECIMAL(20,8)
);

-- User ad preferences (for 80/20 personalization)
CREATE TABLE user_ad_preferences (
    device_id VARCHAR(255),
    ad_unit_id UUID REFERENCES ad_units(id),
    ad_campaign_id UUID REFERENCES ad_campaigns(id),
    click_count INT DEFAULT 0,
    last_click TIMESTAMP,
    PRIMARY KEY (device_id, ad_unit_id, ad_campaign_id)
);

-- Retargeting campaigns
CREATE TABLE retargeting_campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    advertiser_id UUID REFERENCES users(id),
    original_campaign_id UUID REFERENCES ad_campaigns,
    target_device_id VARCHAR(255) NOT NULL,
    ad_creative_url TEXT,
    destination_url TEXT,
    action_button_type VARCHAR(50),
    action_button_data JSONB,
    bid_amount DECIMAL(10,6) NOT NULL,
    start_time TIMESTAMP DEFAULT NOW(),
    end_time TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Transaction ledger (immutable)
CREATE TABLE transaction_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    tx_hash VARCHAR(255) UNIQUE,
    change_type VARCHAR(20) CHECK (change_type IN ('deposit','withdraw','ad_spend','earnings','admin_adjust')),
    old_balance DECIMAL(20,8),
    new_balance DECIMAL(20,8),
    amount_usdt DECIMAL(20,8),
    reason TEXT,
    admin_ip INET,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Threat feed
CREATE TABLE threat_feed (
    id BIGSERIAL PRIMARY KEY,
    threat_type VARCHAR(50),
    severity INT,
    publisher_id UUID REFERENCES users(id),
    device_id VARCHAR(255),
    ip_address INET,
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Withdrawal requests
CREATE TABLE withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    amount_usdt DECIMAL(20,8),
    wallet_address VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending',
    expected_clear_date DATE,
    processed_by UUID REFERENCES users(id),
    tx_hash VARCHAR(255),
    requested_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_clicks_publisher_date ON clicks_log(publisher_id, click_timestamp);
CREATE INDEX idx_clicks_device ON clicks_log(device_id);
CREATE INDEX idx_clicks_campaign ON clicks_log(ad_campaign_id);
CREATE INDEX idx_retargeting_device ON retargeting_campaigns(target_device_id, status);
CREATE INDEX idx_user_pref_device_unit ON user_ad_preferences(device_id, ad_unit_id);