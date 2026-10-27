package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

/**
 * Minimal factory so ViewModels can take constructor dependencies from the
 * manual ServiceLocator without Hilt/Koin. Usage:
 *   viewModel(factory = voizaViewModelFactory { AuthViewModel(...) })
 */
@Suppress("UNCHECKED_CAST")
fun <VM : ViewModel> voizaViewModelFactory(creator: () -> VM): ViewModelProvider.Factory =
    object : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T = creator() as T
    }
